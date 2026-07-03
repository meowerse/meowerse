import { Button, Card } from "@meowerse/ui";

export default function DevMarketing() {
  return (
    <div className="mw-stack">
      <h1>build on meowerse</h1>
      <p className="mw-muted">add "continue with meowerse" to your app — one login, telegram verification, and granular per-scope consent, on the free tier.</p>
      <Card title="what you get">
        <ul>
          <li>standards oauth2 / oidc with pkce</li>
          <li>public (pkce) or confidential (api key) clients</li>
          <li>choose exactly which data your app may request</li>
          <li>restrict to verified users, config-as-code provisioning</li>
        </ul>
      </Card>
      <p><a href="/login?next=%2Fdevelopers"><Button variant="primary">sign in to manage your apps</Button></a></p>
    </div>
  );
}
