import { Classic } from "@caido/primevue";
import PrimeVue from "primevue/config";
import { createApp } from "vue";

import { setDomainGraphPageActive } from "./features/domainGraph/pageActivity";
import { SDKPlugin } from "./plugins/sdk";
import "./styles/index.css";
import { createCaidoThemeBridge } from "./theme/caidoTheme";
import type { FrontendSDK } from "./types";
import App from "./views/App.vue";

export const init = (sdk: FrontendSDK): void => {
  const app = createApp(App);
  app.use(PrimeVue, {
    unstyled: true,
    pt: Classic,
  });
  app.use(SDKPlugin, sdk);

  const root = document.createElement("div");
  Object.assign(root.style, {
    height: "100%",
    minHeight: "0",
    width: "100%",
  });
  root.id = "plugin--graphx";
  const themeBridge = createCaidoThemeBridge(root);

  const setPageActive = (active: boolean): void => {
    setDomainGraphPageActive(active);
    if (active) themeBridge.start();
    else themeBridge.stop();
  };

  sdk.navigation.onPageChange((page) => {
    setPageActive(page.type === "Plugin" && page.path === "/graphx");
  });
  sdk.navigation.addPage("/graphx", {
    body: root,
    onEnter: () => setPageActive(true),
  });
  app.mount(root);
  sdk.sidebar.registerItem("GraphX", "/graphx", {
    icon: "fas fa-project-diagram",
  });
};
