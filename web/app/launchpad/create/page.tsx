import { PARAMS } from "@twain/shared";
import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import { CreateForm } from "@/components/create/CreateForm";
import { Button, Card } from "@/components/ui";

export const metadata: Metadata = {
  title: "Launch coin",
  description: `Launch a coin paired with ETH or a tokenized stock on Robinhood Chain: ${PARAMS.supply} supply, a launch curve first, then a Uniswap pool with liquidity locked forever.`,
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function CreatePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  return (
    <div className="container-page py-6 md:py-10">
      <Button href="/" variant="outline" size="md" className="bg-surface pl-3.5">
        <ChevronLeft size={18} />
        Back
      </Button>
      <Card padded={false} className="mt-5 overflow-clip">
        <CreateForm initialCoin={one(sp.coin)} initialPair={one(sp.pair)} />
      </Card>
    </div>
  );
}
