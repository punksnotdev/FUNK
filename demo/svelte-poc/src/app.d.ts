declare global {
  namespace App {
    interface Locals {
      // Set by hooks.server.ts: true when the request carries a valid,
      // server-minted admin session cookie.
      isAdmin: boolean;
    }
  }
}

export {};
