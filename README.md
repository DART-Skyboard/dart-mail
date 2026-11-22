# DART Mail

Webmail for `justin@dartmeadow.com` at [mail.dartmeadow.com](https://mail.dartmeadow.com).

The page is static. Sign-in is Microsoft’s own login. Reading, folders, and sending go through Microsoft Graph, so delivery uses the same Office 365 servers as the mailbox. Mail is not copied into this repository.

The mailbox password is not part of this project and must not be committed.

## Connect the Microsoft application

1. Open [Entra](https://entra.microsoft.com) → Applications → App registrations → New registration.
2. Name it `DART Mail`. Accounts in this organizational directory only.
3. Redirect URI: platform **Single-page application**, value `https://mail.dartmeadow.com/`.
4. API permissions → Microsoft Graph → Delegated: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.Read`. Grant admin consent.
5. Copy the Application (client) ID and Directory (tenant) ID into the sign-in screen on the site.

`dart-mail-engine` (private) holds the registration script. There is no client secret: a GitHub Pages site cannot keep one, and a single-page app uses PKCE instead.

While the site is open it re-reads folders and the current mailbox every 45 seconds, including folders you add or remove in Outlook.
