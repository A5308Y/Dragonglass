# Google Calendar bridge setup

This bridge mirrors Dragonglass Scheduled Actions into one dedicated Google Calendar. It runs as your Google account; Dragonglass never receives a Google OAuth token.

1. In Google Calendar, create a dedicated calendar such as **Dragonglass**. Open **Settings and sharing → Integrate calendar** and copy the full **Calendar ID**. Do not use the calendar's display name.
2. Create a standalone project at [script.google.com](https://script.google.com/), replace `Code.gs` with the file in this directory, and enable **Show appsscript.json manifest file** in Project Settings before replacing the manifest too.
3. In the Apps Script editor, open **Project Settings → Script Properties** and add:
   - `CALENDAR_ID`: the dedicated calendar ID.
   - `SHARED_SECRET`: the value generated in Dragonglass settings. Use **Show** or **Copy** beside the Shared secret field to retrieve it.
4. Choose **Deploy → New deployment → Web app**. Run it as **Me** and allow access to **Anyone**. Authorize the requested Calendar access.
5. Copy the deployment URL ending in `/exec` into Dragonglass settings. Do not use the Apps Script editor URL or the test URL ending in `/dev`. Enable sync and use **Test**.

After changing `Code.gs` or `appsscript.json`, update the web-app deployment through **Deploy → Manage deployments → Edit → New version**. Saving the source alone does not update an existing `/exec` deployment.

Keep the deployment URL and secret private. Anyone who has both can alter Dragonglass-managed events in the configured calendar. Workspace administrators can disable public Apps Script web apps; in that case this bridge cannot be used without an administrator-approved deployment.
