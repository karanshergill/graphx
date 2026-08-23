const isIpv4 = (value: string): boolean => {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const octet = Number(part);
      return octet >= 0 && octet <= 255;
    })
  );
};

export const normalizeHostname = (input: string): string | undefined => {
  let value = input.trim().toLowerCase();
  const schemeIndex = value.indexOf("://");
  if (schemeIndex >= 0) {
    value = value.slice(schemeIndex + 3).split(/[/?#]/, 1)[0] ?? "";
  }

  const credentialIndex = value.lastIndexOf("@");
  if (credentialIndex >= 0) value = value.slice(credentialIndex + 1);

  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon >= 0 && firstColon === lastColon) {
    const possiblePort = value.slice(lastColon + 1);
    if (/^\d+$/.test(possiblePort)) value = value.slice(0, lastColon);
  }

  value = value.replace(/\.+$/, "");
  if (
    value.length === 0 ||
    value.length > 253 ||
    value.includes(":") ||
    value.includes("..") ||
    isIpv4(value)
  ) {
    return undefined;
  }

  const labels = value.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9_-]+$/.test(label),
    )
  ) {
    return undefined;
  }

  return value;
};

export const parentHostname = (hostname: string): string | undefined => {
  const separator = hostname.indexOf(".");
  return separator < 0 ? undefined : hostname.slice(separator + 1);
};
