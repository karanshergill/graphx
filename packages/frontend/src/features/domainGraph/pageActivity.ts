import { readonly, ref } from "vue";

const active = ref(false);

export const setDomainGraphPageActive = (value: boolean): void => {
  active.value = value;
};

export const useDomainGraphPageActive = () => readonly(active);
