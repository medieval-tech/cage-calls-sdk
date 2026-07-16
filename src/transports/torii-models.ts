import { AllSourcesFailedError } from "../core/errors.js";
import { resolveRequestBudget } from "../core/request.js";
import type { RepositoryContext } from "../repositories/index.js";
import { transportAttemptsFromError, type ToriiModelRequest } from "./index.js";
import type { DataWarning, RequestOptions, SourceAttempt } from "../core/types.js";

export interface ToriiModelRead<T> {
  items: T[];
  attempts: SourceAttempt[];
  complete: boolean;
  warnings: DataWarning[];
}

export async function readAllToriiModels<T>(
  context: RepositoryContext,
  request: Omit<ToriiModelRequest, "first" | "after">,
  map: (value: Record<string, unknown>) => T,
  options: RequestOptions = {},
): Promise<ToriiModelRead<T>> {
  if (!context.torii) throw new Error("Torii is required for indexed model enumeration.");

  const items: T[] = [];
  const attempts: SourceAttempt[] = [];
  const warnings: DataWarning[] = [];
  let cursor: string | undefined;
  let exhausted = false;
  const budget = resolveRequestBudget(context.budget, options);

  try {
    for (let page = 0; page < budget.maxToriiPages && items.length < budget.maxToriiItems; page += 1) {
      const remaining = budget.maxToriiItems - items.length;
      const response = await context.torii.model<Record<string, unknown>>({
        ...request,
        first: Math.min(1_000, remaining),
        ...(cursor ? { after: cursor } : {}),
      }, options);
      attempts.push(...response.attempts);
      items.push(...response.data.edges.map((edge) => map(edge.node)));

      if (!response.data.pageInfo.hasNextPage) {
        exhausted = true;
        break;
      }

      const nextCursor = response.data.pageInfo.endCursor;
      if (!nextCursor || nextCursor === cursor || response.data.edges.length === 0) {
        warnings.push({
          code: "TORII_CURSOR_STALLED",
          message: `${request.model} pagination stopped because Torii did not return a usable next cursor.`,
          source: "torii",
        });
        break;
      }
      cursor = nextCursor;
    }
  } catch (error) {
    throw new AllSourcesFailedError(`torii.${request.model}`, [
      ...attempts,
      ...transportAttemptsFromError(error),
    ]);
  }

  if (!exhausted && items.length >= budget.maxToriiItems) {
    warnings.push({
      code: "TORII_ITEM_LIMIT",
      message: `${request.model} enumeration reached the ${budget.maxToriiItems} item budget.`,
      source: "torii",
    });
  } else if (!exhausted && !warnings.some((warning) => warning.code === "TORII_CURSOR_STALLED")) {
    warnings.push({
      code: "TORII_PAGE_LIMIT",
      message: `${request.model} enumeration reached the ${budget.maxToriiPages} page budget.`,
      source: "torii",
    });
  }

  return { items, attempts, complete: exhausted, warnings };
}
