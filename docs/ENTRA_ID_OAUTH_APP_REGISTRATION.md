# Entra ID App Registration for OAuth with an A2A Server

This document explains the Microsoft Entra ID requirements and setup steps for obtaining OAuth access tokens that can be used as bearer tokens in this A2A Consumer app.

## Goal

Use an Entra ID app registration to sign in and request an access token for the A2A server API, then provide that token in the **OAuth bearer token** field of the UI.

## When You Need This

You need this setup when the target A2A server:

- requires `Authorization: Bearer <token>` for agent card and/or JSON-RPC endpoints,
- validates tokens issued by Microsoft Entra ID,
- expects a specific audience (`aud`) matching its API Application ID URI.

If the A2A server is anonymous or uses a different identity provider, this guide does not apply.

## Prerequisites

- Access to the Microsoft Entra tenant where the A2A API is registered.
- Permission to create or update App registrations.
- The API identifier for the protected A2A server (for example `api://<api-app-id>`).

## Registration Model

Most integrations involve two app registrations:

1. **A2A API app registration** (resource API)
2. **Client app registration** (used by this SPA/user to obtain tokens)

In many organizations the API app already exists. In that case, you only create/configure the client app and grant it permission to the existing API.

## A2A API App Requirements (Resource)

Ensure the API app registration has these elements:

1. An exposed Application ID URI, such as `api://<api-app-id>`.
2. At least one delegated scope under **Expose an API** (for example `access_as_user`).
3. Optionally, app roles if your server expects application permissions.
4. Token validation in the A2A server configured for:
   - issuer (`iss`) = your Entra tenant,
   - audience (`aud`) = API Application ID URI,
   - required scopes/roles.

## Client App Registration Steps

Use these steps to configure the client app that requests tokens for the A2A API.

1. In Entra admin center, go to **App registrations** and create a new registration.
2. Select the appropriate tenant support option (single-tenant is usually preferred for internal apps).
3. Add redirect URIs depending on your auth flow:
   - SPA flow: add a **Single-page application** redirect URI (for example your local dev URL).
   - Native/public client flow: configure a public client redirect as needed.
4. Under **API permissions**, add delegated permission to the A2A API scope (for example `api://<api-app-id>/access_as_user`).
5. Grant admin consent if required by tenant policy.
6. For confidential clients only (server-side token acquisition), create a client secret or certificate.

## OAuth Flow Guidance for This Project

This project is a browser SPA. The recommended flow is:

1. User signs in with Entra ID.
2. Client requests an access token for the A2A API scope.
3. Access token is pasted/provided into the app's OAuth bearer token input.
4. The app sends `Authorization: Bearer <access_token>` on A2A calls.

Important notes:

- Use authorization code flow with PKCE for SPA scenarios.
- Do not use implicit flow for new implementations.
- Do not use ID tokens as API bearer tokens.

## Required Token Claims for A2A Validation

At minimum, verify that issued access tokens contain:

- `aud`: A2A API Application ID URI
- `iss`: expected Entra issuer URL
- `exp`/`nbf`: valid time window
- `scp` (delegated) and/or `roles` (application) expected by the API
- `tid`: expected tenant

## Local Development Checklist

Before testing A2A calls from this app:

1. Confirm the A2A API validates Entra-issued tokens.
2. Confirm CORS settings on the A2A server for production scenarios.
3. Acquire an access token for the correct scope.
4. Paste the token into the app's OAuth field.
5. Connect and run `SendMessage`/`SendStreamingMessage`.

If you get `401`/`403`, check audience, issuer, scope/role, token expiry, and tenant alignment first.

## Troubleshooting

### 1) Invalid audience

Symptoms:

- `401 Unauthorized`
- API logs indicate audience mismatch

Fix:

- Request token for the API scope associated with the A2A API Application ID URI.
- Update API validation config if the expected audience changed.

### 2) Missing scope or role

Symptoms:

- `403 Forbidden`
- token accepted but authorization fails

Fix:

- Add the correct API permission to the client app.
- Grant admin consent if required.
- Ensure API checks match delegated (`scp`) vs app (`roles`) model.

### 3) Wrong tenant or issuer

Symptoms:

- token signature valid but rejected by policy

Fix:

- Use the correct tenant authority in sign-in/token requests.
- Ensure API issuer configuration matches the tenant in `tid` and `iss`.

### 4) Expired token

Symptoms:

- requests fail after some time with auth errors

Fix:

- Acquire a fresh token and retry.
- For production apps, implement automatic refresh in the auth layer.

## Security Recommendations

- Treat access tokens as secrets.
- Avoid persisting tokens in local storage unless required and risk-assessed.
- Use least-privilege scopes for the A2A API.
- Rotate client secrets/certificates for confidential clients.
- Prefer managed identity or workload identity for service-to-service scenarios.

## Summary

To consume an OAuth-protected A2A server with this app, you need:

1. An Entra-protected A2A API with exposed scope(s).
2. A client app registration with delegated permission to those scope(s).
3. Access tokens whose claims match the API validation rules.

Once configured, provide the access token as the bearer token in the UI and call the A2A endpoints normally.