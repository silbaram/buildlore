/** Shared by source selection and portable provenance validation. */
export const CODE_SOURCE_EXTENSION_PATTERN = /\.(?:bash|c|cc|cjs|cpp|cs|css|cxx|fish|go|h|hpp|htm|html|java|js|jsx|kt|kts|less|mjs|php|py|rb|rs|sass|scala|scss|sh|sql|svelte|swift|ts|tsx|vue|xml|zsh)$/u;

const CREDENTIAL_NAME_PATTERN =
  /(?:^|[/_.-])(?:api[-_]?key|authorization|bearer|credentials?|password|private[-_]?key|refresh[-_]?token|secrets?|tokens?|access[-_]?token)(?:$|[/_.-])/iu;
const CREDENTIAL_VALUE_PATTERN =
  /(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,255}|npm_[A-Za-z0-9]{20,255}|sk-ant-[A-Za-z0-9_-]{20,255}|sk-[A-Za-z0-9_-]{20,255}|AIza[A-Za-z0-9_-]{32,64})/u;

export function hasProtectedCredentialPath(path: string): boolean {
  // Code filenames often describe credential handling or lexical tokens. Their
  // contents still pass through the full sanitizer before persistence or egress.
  const namedPath = CODE_SOURCE_EXTENSION_PATTERN.test(path)
    ? path.slice(0, Math.max(0, path.lastIndexOf('/')))
    : path;
  return CREDENTIAL_NAME_PATTERN.test(namedPath) || CREDENTIAL_VALUE_PATTERN.test(path);
}
