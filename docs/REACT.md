# React Query integration

React support is optional and isolated from the framework-neutral entry point.

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CageCallsProvider,
  useFightEvents,
} from "@medieval-tech/cage-calls-sdk/react";

const queryClient = new QueryClient();

function Events() {
  const query = useFightEvents({ limit: 20 });
  return <pre>{JSON.stringify(query.data?.data, null, 2)}</pre>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <CageCallsProvider client={cageCallsClient}>
        <Events />
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
successful receipt. Transaction lifecycle state remains outside the SDK.
