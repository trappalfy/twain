import { TokenImage } from "@/components/common";
import { Badge, Button, Card, XIcon } from "@/components/ui";
import { TWAIN_TOKEN } from "@/config/twain-token";

const T = TWAIN_TOKEN;

/**
 * /launchpad/twain before $TWAIN exists: the coin page's layout with its identity, and no market data — price, chart,
 * trades and the trade panel appear when TWAIN_TOKEN.address is set (the route then redirects to the live coin page).
 */
export function TwainPrelaunch() {
  return (
    <div className="container-page pt-6 pb-6 md:pt-10 lg:pb-16">
      <div className="grid gap-4 md:gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:grid-rows-[auto_auto_1fr]">
        <Card className="min-w-0 lg:col-start-1">
          <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 gap-4">
              <TokenImage src={T.image} alt={T.name} seed={T.symbol} size={80} priority />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h1 className="min-w-0 truncate text-28 font-semibold tracking-tight text-text">{T.name}</h1>
                  <span className="text-xl text-muted">${T.symbol}</span>
                  <Badge variant="new">Official</Badge>
                </div>
                <p className="mt-2 text-13 text-muted">Contract address is published here at launch.</p>
                <div className="mt-3 flex items-center gap-1.5">
                  <a
                    href={T.x}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="X"
                    title="X"
                    className="grid size-8 place-items-center rounded-full bg-surface-2 text-muted transition-colors hover:text-text"
                  >
                    <XIcon size={15} />
                  </a>
                </div>
              </div>
            </div>
            <div className="shrink-0 md:text-right">
              <div className="text-13 text-muted">Status</div>
              <div className="mt-1 text-28 font-medium tracking-tight text-text">Not launched yet</div>
            </div>
          </div>
        </Card>

        <aside className="min-w-0 space-y-4 md:space-y-6 lg:col-start-2 lg:row-span-3 lg:row-start-1">
          <Card as="section" aria-label={`Trade $${T.symbol}`} className="md:p-6">
            <h2 className="text-base font-medium text-text">Trade ${T.symbol}</h2>
            <p className="mt-2 text-sm text-muted">Buying and selling open on this page the moment ${T.symbol} launches.</p>
            <Button className="mt-5 w-full" size="lg" disabled>
              Not launched yet
            </Button>
            <Button className="mt-3 w-full" variant="outline" href={T.x}>
              <XIcon size={14} />
              Follow for the launch
            </Button>
          </Card>
        </aside>

        <Card className="min-w-0 lg:col-start-1">
          <div className="grid h-[320px] place-items-center rounded-card bg-surface-2 px-6 text-center md:h-[420px]">
            <p className="max-w-sm text-sm text-muted">The chart and trades of ${T.symbol} appear here when it launches.</p>
          </div>
        </Card>

        <Card className="min-w-0 self-start lg:col-start-1">
          <h2 className="text-base font-medium text-text">About</h2>
          <p className="mt-3 text-sm whitespace-pre-line text-muted">{T.description}</p>
        </Card>
      </div>
    </div>
  );
}
