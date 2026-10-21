/** Repository development profile; production Web plugins remain explicit packages. */
export const defaultWebPluginPackages = [
  "@slop-lab/dim-web-plugin-llm-router",
  "@slop-lab/dim-web-plugin-execution",
  "@slop-lab/dim-web-plugin-native-git"
] as const;
