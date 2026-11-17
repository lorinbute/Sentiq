// Passkeys in the pages (FD-IOSPAGES): the browser's WebAuthn on the site; in the iOS app, iOS's own passkeys of
// sentiq.money, asked through the app (a WKWebView on the app's scheme has no WebAuthn). The same JSON either way.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { hostRequest, isEmbeddedApp } from './embed.ts';

type AuthOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];
type RegOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type AuthResponse = Awaited<ReturnType<typeof startAuthentication>>;
type RegResponse = Awaited<ReturnType<typeof startRegistration>>;

/** Passkeys can be used here: in a browser that has WebAuthn, or in the iOS app. */
export function supportsPasskeys(): boolean {
  return isEmbeddedApp() || browserSupportsWebAuthn();
}

/** A passkey answering the server's options (sign-in, switching trading on). */
export function passkeyAuthenticate(optionsJSON: AuthOptions): Promise<AuthResponse> {
  return isEmbeddedApp() ? hostRequest<AuthResponse>('passkeyGet', optionsJSON) : startAuthentication({ optionsJSON });
}

/** A new passkey, made from the server's options (Security). */
export function passkeyRegister(optionsJSON: RegOptions): Promise<RegResponse> {
  return isEmbeddedApp() ? hostRequest<RegResponse>('passkeyCreate', optionsJSON) : startRegistration({ optionsJSON });
}
