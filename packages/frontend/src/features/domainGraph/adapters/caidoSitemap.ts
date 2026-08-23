import type { ScopeDefinition, SitemapDomainEntry } from "shared";

import type { FrontendSDK } from "@/types";

type SubscriptionHandle = {
  stop: () => void;
};

type SubscriptionOptions = {
  scopeId: string;
  onChange: () => void;
  onError: (cause: unknown) => void;
};

export const readScopes = (sdk: FrontendSDK): ScopeDefinition[] =>
  sdk.scopes
    .getScopes()
    .map((scope) => ({
      id: scope.id,
      name: scope.name,
      allowlist: [...scope.allowlist],
      denylist: [...scope.denylist],
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

export const readSitemapDomains = async (
  sdk: FrontendSDK,
  scopeId: string,
): Promise<SitemapDomainEntry[]> => {
  const result = await sdk.graphql.sitemapRootEntries({ scopeId });
  return result.sitemapRootEntries.edges
    .filter((edge) => edge.node.kind === "DOMAIN")
    .map((edge) => ({
      id: edge.node.id,
      label: edge.node.label,
    }));
};

export const subscribeToSitemapDomains = (
  sdk: FrontendSDK,
  { scopeId, onChange, onError }: SubscriptionOptions,
): SubscriptionHandle => {
  let active = true;

  const consume = <T>(
    source: AsyncIterable<T>,
    shouldNotify: (event: T) => boolean,
  ): (() => void) => {
    const iterator = source[Symbol.asyncIterator]();

    void (async () => {
      try {
        while (active) {
          const next = await iterator.next();
          if (next.done === true) break;
          if (shouldNotify(next.value)) onChange();
        }
      } catch (cause: unknown) {
        if (active) onError(cause);
      }
    })();

    return () => {
      if (iterator.return !== undefined) {
        void Promise.resolve(iterator.return()).catch(() => undefined);
      }
    };
  };

  const stopCreated = consume(
    sdk.graphql.createdSitemapEntry({ scopeId }),
    (event) =>
      event.createdSitemapEntry.sitemapEntryEdge.node.kind === "DOMAIN",
  );
  const stopUpdated = consume(
    sdk.graphql.updatedSitemapEntry({ scopeId }),
    (event) =>
      event.updatedSitemapEntry.sitemapEntryEdge.node.kind === "DOMAIN",
  );
  const stopDeleted = consume(sdk.graphql.deletedSitemapEntry(), () => true);

  return {
    stop: () => {
      active = false;
      stopCreated();
      stopUpdated();
      stopDeleted();
    },
  };
};
