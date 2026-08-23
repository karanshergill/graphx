import type { Result } from "shared";
import { computed, onBeforeUnmount, readonly, ref, watch } from "vue";

import { useDomainGraphPageActive } from "../pageActivity";

import { useSDK } from "@/plugins/sdk";

type ListenerHandle = { stop: () => void };

export const useDomainMarks = () => {
  const sdk = useSDK();
  const isActive = useDomainGraphPageActive();
  const marks = ref<ReadonlySet<string>>(new Set());
  const listeners: ListenerHandle[] = [];
  let running = false;

  const apply = async (action: Promise<Result<string[]>>): Promise<void> => {
    const result = await action;
    if (result.kind === "Ok") {
      marks.value = new Set(result.value);
    } else {
      sdk.window.showToast(result.error, { variant: "error" });
    }
  };

  const mark = (hostnames: string[]): Promise<void> =>
    apply(sdk.backend.addDomainMarks(hostnames));
  const unmark = (hostnames: string[]): Promise<void> =>
    apply(sdk.backend.removeDomainMarks(hostnames));

  const stop = (): void => {
    if (!running) return;
    running = false;
    for (const listener of listeners.splice(0)) listener.stop();
    marks.value = new Set();
  };

  const start = (): void => {
    if (running) return;
    running = true;
    listeners.push(
      sdk.backend.onEvent("domainMarks:changed", (hostnames) => {
        marks.value = new Set(hostnames);
      }),
      sdk.backend.onEvent("project:changed", () => {
        void apply(sdk.backend.listDomainMarks());
      }),
    );
    void apply(sdk.backend.listDomainMarks());
  };

  watch(isActive, (active) => (active ? start() : stop()), {
    immediate: true,
  });

  onBeforeUnmount(stop);

  return {
    mark,
    markedCount: computed(() => marks.value.size),
    marks: readonly(marks),
    unmark,
  };
};
