export interface ConsentPageParams {
  client_id: string;
  client_name?: string | undefined;
  redirect_uri: string;
  response_type: string;
  code_challenge: string;
  code_challenge_method: string;
  scope?: string | undefined;
  state?: string | undefined;
  resource?: string | undefined;
  error?: string | undefined;
}

/** HTML-escape a string so it's safe to interpolate into element/attribute content. */
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hidden(name: string, value: string | undefined): string {
  if (value === undefined) return "";
  return `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
}

export function renderConsentPage(params: ConsentPageParams): string {
  const clientLabel = params.client_name ?? params.client_id;
  const errorHtml = params.error
    ? `<p class="error">${escape(params.error)}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Bumble</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #fafafa; color: #222; margin: 0; padding: 2rem; }
  main { max-width: 28rem; margin: 4rem auto; background: #fff; padding: 2rem; border-radius: 0.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { margin-top: 0; font-size: 1.25rem; }
  p { line-height: 1.5; }
  .client { font-weight: 600; }
  .scope { background: #eef; display: inline-block; padding: 0.1rem 0.4rem; border-radius: 0.25rem; font-family: ui-monospace, monospace; font-size: 0.85em; }
  label { display: block; margin-top: 1rem; font-weight: 500; }
  input[type=password] { width: 100%; padding: 0.5rem; box-sizing: border-box; border: 1px solid #ccc; border-radius: 0.25rem; font-size: 1rem; margin-top: 0.25rem; }
  button { margin-top: 1rem; padding: 0.6rem 1rem; background: #2563eb; color: #fff; border: 0; border-radius: 0.25rem; cursor: pointer; font-size: 1rem; }
  button:hover { background: #1d4ed8; }
  .error { background: #fee; color: #b00; padding: 0.5rem; border-radius: 0.25rem; }
</style>
</head>
<body>
<main>
  <h1>Authorize Bumble</h1>
  <p>The client <span class="client">${escape(clientLabel)}</span> wants to access your Bumble MCP server with scope <span class="scope">${escape(params.scope ?? "mcp")}</span>.</p>
  ${errorHtml}
  <form method="POST" action="/authorize">
    ${hidden("response_type", params.response_type)}
    ${hidden("client_id", params.client_id)}
    ${hidden("redirect_uri", params.redirect_uri)}
    ${hidden("code_challenge", params.code_challenge)}
    ${hidden("code_challenge_method", params.code_challenge_method)}
    ${hidden("scope", params.scope)}
    ${hidden("state", params.state)}
    ${hidden("resource", params.resource)}
    <label for="password">Admin password</label>
    <input type="password" name="password" id="password" autocomplete="current-password" required autofocus>
    <button type="submit">Approve</button>
  </form>
</main>
</body>
</html>`;
}
