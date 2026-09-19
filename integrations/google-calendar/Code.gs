const BRIDGE_VERSION = 1;

function doPost(event) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    const request = JSON.parse(event && event.postData ? event.postData.contents : "{}");
    const properties = PropertiesService.getScriptProperties();
    const secret = properties.getProperty("SHARED_SECRET") || "";
    const calendarId = properties.getProperty("CALENDAR_ID") || "";
    if (!secret || !calendarId) throw new Error("Set SHARED_SECRET and CALENDAR_ID in Script Properties.");
    if (request.secret !== secret) throw new Error("The shared secret is incorrect.");
    if (request.version !== BRIDGE_VERSION) throw new Error("Unsupported bridge version.");
    if (typeof request.sourceId !== "string" || !/^[0-9A-Za-z_-]{10,128}$/.test(request.sourceId)) throw new Error("Invalid Dragonglass source ID.");

    let calendar;
    try {
      calendar = Calendar.Calendars.get(calendarId);
    } catch (calendarError) {
      if (/not found/i.test(String(calendarError && calendarError.message ? calendarError.message : calendarError))) {
        throw new Error("Calendar not found. Check that CALENDAR_ID is the calendar ID—not its name—and that the deploying Google account can access it.");
      }
      throw calendarError;
    }
    if (request.operation === "test") return jsonResponse({ ok: true, calendar: calendar.summary });
    if (request.operation !== "reconcile" || !Array.isArray(request.events)) throw new Error("Invalid bridge operation.");
    if (request.events.length > 5000) throw new Error("Too many events in one request.");

    const source = request.sourceId;
    const existing = listManagedEvents(calendarId, source);
    const desiredActionIds = {};
    const counts = { created: 0, updated: 0, deleted: 0, unchanged: 0 };

    request.events.forEach(function (input) {
      validateEvent(input);
      desiredActionIds[input.actionId] = true;
      const resource = eventResource(input, source);
      const current = existing[input.actionId];
      if (!current) {
        try {
          Calendar.Events.insert(resource, calendarId);
        } catch (error) {
          // A manually deleted event may retain its ID as a cancelled tombstone.
          Calendar.Events.update(resource, calendarId, resource.id);
        }
        counts.created += 1;
      } else if (eventMatches(current, resource)) {
        counts.unchanged += 1;
      } else {
        Calendar.Events.update(resource, calendarId, current.id);
        counts.updated += 1;
      }
    });

    Object.keys(existing).forEach(function (actionId) {
      if (desiredActionIds[actionId]) return;
      Calendar.Events.remove(calendarId, existing[actionId].id);
      counts.deleted += 1;
    });
    return jsonResponse(Object.assign({ ok: true, calendar: calendar.summary }, counts));
  } catch (error) {
    return jsonResponse({ ok: false, error: error && error.message ? error.message : String(error) });
  } finally {
    try { lock.releaseLock(); } catch (_) { /* Lock was not acquired. */ }
  }
}

function listManagedEvents(calendarId, source) {
  const result = {};
  let pageToken;
  do {
    const page = Calendar.Events.list(calendarId, {
      maxResults: 2500,
      pageToken: pageToken,
      privateExtendedProperty: "dragonglassSource=" + source,
      showDeleted: false,
      singleEvents: false,
    });
    (page.items || []).forEach(function (item) {
      const privateProperties = item.extendedProperties && item.extendedProperties.private;
      const actionId = privateProperties && privateProperties.dragonglassActionId;
      if (actionId) result[actionId] = item;
    });
    pageToken = page.nextPageToken;
  } while (pageToken);
  return result;
}

function eventResource(input, source) {
  const fingerprint = sha256Hex(JSON.stringify({
    summary: input.summary,
    description: input.description,
    start: input.start,
    end: input.end,
  }));
  return {
    id: "dg" + sha256Hex("dragonglass-event:" + source + ":" + input.actionId).slice(0, 50),
    status: "confirmed",
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.start },
    end: { dateTime: input.end },
    transparency: "opaque",
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        dragonglassSource: source,
        dragonglassActionId: input.actionId,
        dragonglassFingerprint: fingerprint,
      },
    },
  };
}

function eventMatches(current, desired) {
  const properties = current.extendedProperties && current.extendedProperties.private;
  return current.status !== "cancelled"
    && current.summary === desired.summary
    && current.description === desired.description
    && current.start && current.start.dateTime === desired.start.dateTime
    && current.end && current.end.dateTime === desired.end.dateTime
    && current.transparency === desired.transparency
    && current.reminders && current.reminders.useDefault === true
    && properties && properties.dragonglassFingerprint === desired.extendedProperties.private.dragonglassFingerprint;
}

function validateEvent(input) {
  if (!input || typeof input.actionId !== "string" || !input.actionId) throw new Error("An event has no Action ID.");
  if (typeof input.summary !== "string" || !input.summary) throw new Error("An event has no title.");
  if (typeof input.description !== "string") throw new Error("An event description is invalid.");
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) throw new Error("An event has an invalid time range.");
}

function sha256Hex(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (byte) { return (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, "0"); })
    .join("");
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
