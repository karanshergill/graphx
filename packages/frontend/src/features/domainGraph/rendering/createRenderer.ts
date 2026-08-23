import { createCanvasDomainGraphRenderer } from "./canvasDomainGraphRenderer";
import {
  createSigmaDomainGraphRenderer,
  type DomainGraphRenderer,
  type DomainGraphRendererCallbacks,
} from "./domainGraphRenderer";

const supportsWebGL = (): boolean => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (context === null) return false;
  context.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
};

const identifyRenderer = (
  container: HTMLElement,
  kind: "canvas-2d" | "sigma",
  renderer: DomainGraphRenderer,
): DomainGraphRenderer => {
  container.dataset.graphxRenderer = kind;
  return {
    clearSelection: renderer.clearSelection,
    update: renderer.update,
    destroy: () => {
      renderer.destroy();
      delete container.dataset.graphxRenderer;
    },
    focusNode: renderer.focusNode,
    resetView: renderer.resetView,
    selectByKeyboard: renderer.selectByKeyboard,
  };
};

export const createDomainGraphRenderer = (
  container: HTMLElement,
  callbacks: DomainGraphRendererCallbacks,
): DomainGraphRenderer => {
  if (supportsWebGL()) {
    try {
      return identifyRenderer(
        container,
        "sigma",
        createSigmaDomainGraphRenderer(container, callbacks),
      );
    } catch {
      container.replaceChildren();
    }
  }

  return identifyRenderer(
    container,
    "canvas-2d",
    createCanvasDomainGraphRenderer(container, callbacks),
  );
};
