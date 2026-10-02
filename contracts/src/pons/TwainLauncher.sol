// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPonsV2Curve, IPonsV2Factory, PonsSocials, PonsTokenParams} from "./IPonsV2.sol";
import {TwainFeeVault} from "./TwainFeeVault.sol";

/// @title TwainLauncher
/// @notice Launches coins through the official Pons V2 factory. Every coin gets its own TwainFeeVault as the Pons
///         creator fee recipient and a creator tax of CREATOR_TAX_BPS; the vault splits the creator's income
///         between the creator and the twain treasury. The optional first buy goes through the coin's Pons curve
///         in the same transaction and is exempt from the Pons snipe tax.
///         This contract never holds funds between transactions and never buys for itself (Pons exempts the
///         launcher from the snipe tax, so it must not offer buys with itself as recipient).
contract TwainLauncher is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Creator tax charged on every trade of a twain coin, paid to its vault: 100 = 1%.
    uint16 public constant CREATOR_TAX_BPS = 100;
    /// @notice Pons launch config used for every coin (1B supply, 1% curve fee, graduation into a Uniswap v4 pool).
    uint256 public constant LAUNCH_CONFIG_ID = 0;

    IPonsV2Factory public immutable pons;
    address public immutable vaultImplementation;

    address public treasury;
    bool public paused;

    mapping(address coin => address vault) public vaultOf;
    /// @notice Launch count per creator; the Pons CREATE2 salt is keccak(creator, nonce).
    mapping(address creator => uint256) public nonces;

    /// @notice What the creator chooses. `expectedEconomics` pins the Pons curve terms the site showed
    ///         (PonsV2LaunchFactory.previewLaunchEconomics); 0 accepts the current ones.
    struct CoinParams {
        string name;
        string symbol;
        string logo;
        string description;
        PonsSocials socials;
        bytes32 expectedEconomics;
    }

    event CoinLaunched(
        address indexed coin,
        address indexed creator,
        address indexed pairToken,
        address curve,
        address vault,
        uint256 quoteIn,
        uint256 coinsOut
    );
    event TreasuryUpdated(address treasury);
    event PausedSet(bool paused);

    error LaunchesPaused();
    error WrongValue();
    error ZeroAddress();
    error EthTransferFailed();
    error NoRenounce();

    constructor(address owner_, address treasury_, IPonsV2Factory pons_) Ownable(owner_) {
        if (treasury_ == address(0) || address(pons_) == address(0)) revert ZeroAddress();
        treasury = treasury_;
        pons = pons_;
        vaultImplementation = address(new TwainFeeVault());
    }

    /// @notice Launches a coin paired with `pairToken` (address(0) = ETH, otherwise a Pons-approved ERC-20).
    /// @param quoteIn First buy in the pair asset (0 = none); minCoinsOut is its slippage bound.
    /// @dev msg.value = Pons launch fee, plus quoteIn when the pair is ETH. An ERC-20 first buy needs an allowance.
    function launch(CoinParams calldata p, address pairToken, uint256 quoteIn, uint256 minCoinsOut)
        external
        payable
        nonReentrant
        returns (address coin, address curve, address vault)
    {
        if (paused) revert LaunchesPaused();
        uint256 fee = pons.launchFee();
        if (msg.value != fee + (pairToken == address(0) ? quoteIn : 0)) revert WrongValue();

        vault = Clones.clone(vaultImplementation);
        address[] memory exempt = new address[](1);
        exempt[0] = msg.sender;
        (coin, curve) = pons.launchToken{value: fee}(
            PonsTokenParams({
                name: p.name,
                symbol: p.symbol,
                logo: p.logo,
                description: p.description,
                socials: p.socials,
                creatorFeeRecipient: vault,
                creatorTaxBps: CREATOR_TAX_BPS,
                buybackEnabled: false,
                expectedEconomics: p.expectedEconomics,
                salt: keccak256(abi.encode(msg.sender, nonces[msg.sender]++))
            }),
            LAUNCH_CONFIG_ID,
            pairToken,
            exempt
        );
        TwainFeeVault(payable(vault)).initialize(pons, coin, curve, pairToken, msg.sender);
        vaultOf[coin] = vault;

        uint256 coinsOut = quoteIn == 0 ? 0 : _firstBuy(curve, pairToken, quoteIn, minCoinsOut);
        emit CoinLaunched(coin, msg.sender, pairToken, curve, vault, quoteIn, coinsOut);
    }

    /// @dev Buys on the curve for the creator; whatever the curve refunds (allocation exhausted) goes back to them.
    function _firstBuy(address curve, address pairToken, uint256 quoteIn, uint256 minCoinsOut)
        private
        returns (uint256 coinsOut)
    {
        if (pairToken == address(0)) {
            uint256 before = address(this).balance - quoteIn;
            coinsOut = IPonsV2Curve(curve).buy{value: quoteIn}(quoteIn, minCoinsOut, msg.sender);
            uint256 refund = address(this).balance - before;
            if (refund > 0) {
                (bool ok,) = msg.sender.call{value: refund}("");
                if (!ok) revert EthTransferFailed();
            }
        } else {
            IERC20 quote = IERC20(pairToken);
            uint256 before = quote.balanceOf(address(this));
            quote.safeTransferFrom(msg.sender, address(this), quoteIn);
            quote.forceApprove(curve, quoteIn);
            coinsOut = IPonsV2Curve(curve).buy(quoteIn, minCoinsOut, msg.sender);
            quote.forceApprove(curve, 0);
            uint256 refund = quote.balanceOf(address(this)) - before;
            if (refund > 0) quote.safeTransfer(msg.sender, refund);
        }
    }

    /// @dev Curve refunds of a first buy arrive here and are forwarded within the same call.
    receive() external payable {}

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Pause or resume new launches. Trading and fee withdrawals are never affected.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function renounceOwnership() public pure override {
        revert NoRenounce();
    }
}
