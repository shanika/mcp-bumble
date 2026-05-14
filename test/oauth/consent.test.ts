import { describe, expect, it } from "vitest";

import { renderConsentPage } from "../../src/oauth/consent.js";

describe("renderConsentPage", () => {
  it("renders an HTML form with hidden fields and a password input", () => {
    const html = renderConsentPage({
      client_id: "cli-1",
      client_name: "Claude",
      redirect_uri: "http://localhost:9000/cb",
      response_type: "code",
      code_challenge: "abc",
      code_challenge_method: "S256",
      scope: "mcp",
      state: "xyz",
      resource: "https://bumble.example",
    });

    expect(html).toContain('<form method="POST" action="/authorize">');
    expect(html).toContain('name="client_id" value="cli-1"');
    expect(html).toContain(
      'name="redirect_uri" value="http://localhost:9000/cb"',
    );
    expect(html).toContain('name="code_challenge" value="abc"');
    expect(html).toContain('name="code_challenge_method" value="S256"');
    expect(html).toContain('name="scope" value="mcp"');
    expect(html).toContain('name="state" value="xyz"');
    expect(html).toContain('name="resource" value="https://bumble.example"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Claude");
  });

  it("falls back to client_id when no client_name is present", () => {
    const html = renderConsentPage({
      client_id: "cli-7",
      redirect_uri: "http://localhost/cb",
      response_type: "code",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
    expect(html).toContain(">cli-7<");
  });

  it("escapes HTML in user-controllable fields", () => {
    const html = renderConsentPage({
      client_id: "<script>x</script>",
      client_name: '" onmouseover="alert(1)',
      redirect_uri: "http://localhost/cb?q=<>&'\"",
      response_type: "code",
      code_challenge: "c",
      code_challenge_method: "S256",
      error: "<b>nope</b>",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain('" onmouseover="alert(1)');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&#39;");
    expect(html).toContain("&lt;b&gt;nope&lt;/b&gt;");
  });

  it("omits hidden inputs for undefined optional params", () => {
    const html = renderConsentPage({
      client_id: "cli-1",
      redirect_uri: "http://localhost/cb",
      response_type: "code",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
    expect(html).not.toContain('name="state"');
    expect(html).not.toContain('name="resource"');
  });

  it("renders an error message when error is set", () => {
    const html = renderConsentPage({
      client_id: "cli-1",
      redirect_uri: "http://localhost/cb",
      response_type: "code",
      code_challenge: "c",
      code_challenge_method: "S256",
      error: "Incorrect password.",
    });
    expect(html).toContain('class="error"');
    expect(html).toContain("Incorrect password.");
  });
});
