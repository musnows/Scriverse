export function isPhoneClient(navigatorLike = globalThis.navigator) {
  const mobile = navigatorLike?.userAgentData?.mobile;
  if (typeof mobile === "boolean") return mobile;
  const userAgent = String(navigatorLike?.userAgent ?? "");
  return /(?:Android.*Mobile|iPhone|iPod|IEMobile|Windows Phone|Opera Mini)/iu.test(userAgent);
}
