type ThemeAttributeSource = Pick<Element, "getAttribute">;
type ThemeAttributeTarget = Pick<Element, "removeAttribute" | "setAttribute">;

type CaidoThemeBridge = {
  start: () => void;
  stop: () => void;
};

const THEME_ATTRIBUTE = "data-mode";

export const syncCaidoThemeMode = (
  source: ThemeAttributeSource,
  target: ThemeAttributeTarget,
): void => {
  const mode = source.getAttribute(THEME_ATTRIBUTE);
  if (mode === null || mode.length === 0) {
    target.removeAttribute(THEME_ATTRIBUTE);
    return;
  }

  target.setAttribute(THEME_ATTRIBUTE, mode);
};

export const createCaidoThemeBridge = (
  target: HTMLElement,
  source: HTMLElement = document.documentElement,
): CaidoThemeBridge => {
  let observer: MutationObserver | undefined;
  const sync = (): void => syncCaidoThemeMode(source, target);

  sync();

  return {
    start: () => {
      sync();
      if (observer !== undefined) return;
      observer = new MutationObserver(sync);
      observer.observe(source, {
        attributeFilter: [THEME_ATTRIBUTE],
        attributes: true,
      });
    },
    stop: () => {
      observer?.disconnect();
      observer = undefined;
    },
  };
};
