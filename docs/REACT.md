# React Query integration

React support is optional and isolated from the framework-neutral entry point.

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CageCallsProvider,
  useInfiniteAccountFightStates,
  useInfiniteMarketCatalog,
} from "@medieval-tech/cage-calls-sdk/react";

const queryClient = new QueryClient();

function Markets() {
  const query = useInfiniteMarketCatalog({ limit: 20 });
  const items = query.data?.pages.flatMap((page) => page.data.items) ?? [];
  return <button onClick={() => query.fetchNextPage()}>{items.length} markets</button>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <CageCallsProvider client={cageCallsClient}>
        <Markets />
      </CageCallsProvider>
    </QueryClientProvider>
  );
}
```

`CageCallsProvider` must be nested below `QueryClientProvider`. Hooks do not refetch on window
focus by default. `useCageCallsLive()` consumes an optional typed Torii subscription adapter and
invalidates affected query keys. Reconnection emits one reconciliation invalidation and never
starts a polling loop.

Applications executing transactions should invalidate the exported Cage Calls query keys after a
successful receipt. `cageCallsQueryKeys.all()` is the root key and is the safest invalidation for
multi-screen mutations; narrower keys remain available for consumers that can prove the affected
scope. Transaction lifecycle state remains outside the SDK.

The React entry point includes exhaustive hooks (`useAllFighters`, `useAllFightFeed`,
`useAllRegisteredTokens`, and `useAllRegisteredOracles`) plus infinite hooks for the market catalog
and account fight state. Exhaustive hooks obey the SDK traversal budget; infinite hooks expose
explicit user-driven pagination without client-side cursor loops.
