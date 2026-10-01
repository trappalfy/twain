"use client";

import { shortAddress } from "@twain/shared";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ChevronDown, Coins, Copy, LogOut, User } from "lucide-react";
import { toast } from "sonner";
import { useDisconnect, useSwitchChain } from "wagmi";
import { Identicon } from "@/components/common/Identicon";
import { Dropdown } from "@/components/ui/Dropdown";
import { LiquidButton } from "@/components/ui/liquid-glass";
import { toFriendlyError, isUserRejection } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { appChain } from "@/lib/wagmi";

function SwitchChainButton({ className }: { className?: string }) {
  const { switchChain, isPending } = useSwitchChain();
  return (
    <LiquidButton
      variant="primary"
      size="md"
      disabled={isPending}
      className={className}
      onClick={() =>
        switchChain(
          { chainId: appChain.id },
          { onError: (e) => (isUserRejection(e) ? undefined : toast.error(toFriendlyError(e))) },
        )
      }
    >
      Switch network
    </LiquidButton>
  );
}

function AccountMenu({ address, className }: { address: string; className?: string }) {
  const { disconnect } = useDisconnect();
  return (
    <Dropdown
      trigger={
        <LiquidButton variant="primary" size="md" className={cn("gap-2 pl-1.5 pr-3.5", className)}>
          <Identicon address={address} size={30} />
          <span className="font-mono text-13 font-medium">{shortAddress(address)}</span>
          <ChevronDown size={16} className="opacity-80" />
        </LiquidButton>
      }
      items={[
        { label: "Profile", icon: <User />, href: "/profile" },
        { label: "Creator fees", icon: <Coins />, href: "/profile#creator-fees" },
        {
          label: "Copy address",
          icon: <Copy />,
          onSelect: () => {
            void navigator.clipboard.writeText(address).then(() => toast.success("Address copied"));
          },
        },
        { type: "separator" },
        { label: "Disconnect", icon: <LogOut />, onSelect: () => disconnect() },
      ]}
    />
  );
}

/**
 * The dark (ink) glass button of the nav capsule, in the slot the header brief gives "Launch app":
 * Connect wallet → address with a menu; wrong network → Switch network.
 */
export function WalletButton({ className }: { className?: string }) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, mounted }) => {
        if (!mounted) return <div aria-hidden className={cn("h-11 w-36 rounded-full", className)} />;
        if (!account || !chain) {
          return (
            <LiquidButton variant="primary" size="md" className={className} onClick={openConnectModal}>
              Connect wallet
            </LiquidButton>
          );
        }
        if (chain.unsupported) return <SwitchChainButton className={className} />;
        return <AccountMenu address={account.address} className={className} />;
      }}
    </ConnectButton.Custom>
  );
}
