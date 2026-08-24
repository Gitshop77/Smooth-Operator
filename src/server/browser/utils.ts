/** Small pure helpers shared by browser state and tests. */

const SENSITIVE_URL_PART = /(access[_-]?token|api[_-]?key|auth|code|credential|jwt|nonce|otp|password|secret|session|sig(?:nature)?|token)/i;
const MAX_SAFE_INPUT_LENGTH = 16_384;
const MAX_SAFE_URL_LENGTH = 4_096;
const MAX_SAFE_QUERY_PARAMETERS = 64;
const MAX_SAFE_PATH_LENGTH = 2_048;
const QUERY_TRUNCATION_KEY = "__smooth_operator_truncated";

export function sanitizeUrl(rawUrl: string): string {
  if (rawUrl.length > MAX_SAFE_INPUT_LENGTH) {
    return "[URL_TOO_LONG]";
  }
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    const redactedSearch = new URLSearchParams();
    let parameterCount = 0;
    let truncated = false;
    for (const [key, value] of url.searchParams) {
      if (parameterCount >= MAX_SAFE_QUERY_PARAMETERS) {
        truncated = true;
        break;
      }
      const boundedKey = key.slice(0, 500);
      const boundedValue = SENSITIVE_URL_PART.test(key) || SENSITIVE_URL_PART.test(value) ? "[redacted]" : value.slice(0, 500);
      truncated ||= key.length > boundedKey.length || value.length > 500;
      // append() intentionally preserves duplicate parameter ordering. Using
      // set() here silently changed URLs such as ?id=1&id=2 into one value.
      redactedSearch.append(boundedKey, boundedValue);
      parameterCount += 1;
    }
    if (truncated) {
      redactedSearch.append(QUERY_TRUNCATION_KEY, "[truncated]");
    }
    url.search = redactedSearch.toString();
    if (url.hash) {
      url.hash = SENSITIVE_URL_PART.test(url.hash) ? "[redacted]" : url.hash.slice(0, 500);
    }
    if (url.pathname.length > MAX_SAFE_PATH_LENGTH) {
      url.pathname = `${url.pathname.slice(0, MAX_SAFE_PATH_LENGTH)}…[truncated]`;
    }
    const serialized = url.toString();
    return serialized.length > MAX_SAFE_URL_LENGTH ? `${serialized.slice(0, MAX_SAFE_URL_LENGTH)}…[truncated]` : serialized;
  } catch {
    return "[INVALID_URL]";
  }
}

export function globMatches(value: string, glob: string): boolean {
  if (value.length > MAX_SAFE_INPUT_LENGTH || glob.length > MAX_SAFE_INPUT_LENGTH) {
    return false;
  }
  // URL globs use the browser-use convention: `*` stays within one URL
  // component while `**` may cross `/` boundaries. Treating every star as
  // `.*` makes a pattern such as `https://example.test/*` unexpectedly match
  // nested paths and is particularly surprising for wait_for_url.
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else {
      expression += character.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`${expression}$`).test(value);
  } catch {
    return false;
  }
}
