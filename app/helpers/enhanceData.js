const { DateTime } = require('luxon');
const generateGroupId = require('./groupId');

function bookingKeyFromISO(datetime, timezone) {
  return DateTime.fromISO(datetime, { zone: timezone }).toFormat("yyyy-MM-dd'T'HH:mm");
}

function bookingBucketKey({ slotKey, sessionId, recurringSessionId }) {
  if (sessionId) return `session:${sessionId}:${slotKey}`;
  if (recurringSessionId) return `recurring:${recurringSessionId}:${slotKey}`;
  return `time:${slotKey}`;
}

function bookingBucketKeysForSlot(slot) {
  const keys = [];

  if (slot?.sessionId && slot?.slotKey) {
    keys.push(bookingBucketKey({ slotKey: slot.slotKey, sessionId: slot.sessionId }));
  }

  if (slot?.recurringSessionId && slot?.slotKey) {
    keys.push(bookingBucketKey({ slotKey: slot.slotKey, recurringSessionId: slot.recurringSessionId }));
  }

  if (slot?.slotKey) {
    keys.push(bookingBucketKey({ slotKey: slot.slotKey }));
  }

  return keys;
}

function bookingBucketKeysForBooking(booking, timezone) {
  const slotKey = booking?.slotKey || bookingKeyFromISO(booking?.datetime, timezone);
  if (!slotKey) return [];

  const keys = [];

  if (booking?.sessionId) {
    keys.push(bookingBucketKey({ slotKey, sessionId: booking.sessionId }));
  }

  if (booking?.recurringSessionId) {
    keys.push(bookingBucketKey({ slotKey, recurringSessionId: booking.recurringSessionId }));
  }

  // Only fall back to time-only matching for bookings that have no session identity.
  // This prevents cross-clinic assignment when two sessions share the same datetime.
  if (!booking?.sessionId && !booking?.recurringSessionId) {
    keys.push(bookingBucketKey({ slotKey }));
  }

  return keys;
}

const ACTIVE_BOOKING_STATUSES = ['scheduled', 'orphaned'];

function buildSlotId({ sessionKey, slotKey, capacityIndex }) {
  return `${sessionKey}|${slotKey}|${capacityIndex}`;
}

/**
 * Build slot structures for each site and date.
 * - Expands all sessions into time slots.
 * - Marks which slots are booked, cancelled, etc.
 *
 * @param {Object} options.daily_availability - { [site_id]: { [date]: { sessions: [...] } } }
 * @param {Object} options.bookings - { [site_id]: { [bookingId]: bookingData } }
 * @param {Object} [options.blocked_slots] - { [site_id]: [{ slotId, reason, ... }] }
 * @param {String} [options.timezone='Europe/London']
 *
 * @returns {Object} { [site_id]: { [date]: [slot, slot, ...] } }
 */
function enhanceData({ daily_availability, bookings, blocked_slots, timezone = 'Europe/London' }) {
  const slots = {};

  for (const [site_id, availability] of Object.entries(daily_availability || {})) {
    slots[site_id] = {};

    const blocksBySlotId = new Map(
      (Array.isArray(blocked_slots?.[site_id]) ? blocked_slots[site_id] : [])
        .filter((block) => block?.slotId)
        .map((block) => [block.slotId, block])
    );

    const bookingBuckets = new Map();
    const bookingById = new Map();
    const assignedBookingIds = new Set();
    for (const [id, b] of Object.entries(bookings?.[site_id] || {})) {
      if (!b?.datetime) continue;

      const booking = { id, ...b };
      bookingById.set(String(id), booking);

      for (const key of bookingBucketKeysForBooking(booking, timezone)) {
        const existing = bookingBuckets.get(key) || [];
        existing.push(String(id));
        bookingBuckets.set(key, existing);
      }
    }

    const assignBookingToSlot = (slotDescriptor) => {
      for (const bucketKey of bookingBucketKeysForSlot(slotDescriptor)) {
        const bookingIds = bookingBuckets.get(bucketKey) || [];

        for (const bookingId of bookingIds) {
          if (assignedBookingIds.has(String(bookingId))) continue;

          assignedBookingIds.add(String(bookingId));
          return bookingById.get(String(bookingId)) || null;
        }
      }

      return null;
    };

    const addUnmatchedBookingsToSlots = () => {
      for (const [bookingId, booking] of bookingById.entries()) {
        if (assignedBookingIds.has(bookingId)) continue;

        const slotKey = booking.slotKey || bookingKeyFromISO(booking.datetime, timezone);
        if (!slotKey) continue;

        const date = booking.datetime.slice(0, 10);
        if (!slots[site_id][date]) {
          slots[site_id][date] = [];
        }

        slots[site_id][date].push({
          datetime: booking.datetime,
          slotKey,
          date,
          group: null,
          sessionId: null,
          recurringSessionId: null,
          site_id,
          slotLength: null,
          capacity: 0,
          capacity_index: null,
          services: booking.service ? [booking.service] : [],
          booked: true,
          booking_id: booking.id,
          booking_status: booking.status
        });

        assignedBookingIds.add(bookingId);
      }

      for (const dateSlots of Object.values(slots[site_id])) {
        dateSlots.sort((a, b) => String(a.datetime || '').localeCompare(String(b.datetime || '')));
      }
    };

    const allDates = new Set([
      ...Object.keys(availability || {}),
      ...Object.values(bookingById)
        .filter((booking) => booking?.datetime)
        .map((booking) => String(booking.datetime).slice(0, 10))
    ]);

    for (const date of allDates) {
      const day = availability?.[date];
      if (!slots[site_id][date]) {
        slots[site_id][date] = [];
      }

      if (!day?.sessions?.length) {
        continue;
      }

      for (const session of day.sessions) {
        const start = DateTime.fromISO(`${date}T${session.from}`, { zone: timezone });
        const end = DateTime.fromISO(`${date}T${session.until}`, { zone: timezone });
        const slotLength = session.slotLength || 10;
        const capacity = session.capacity || 1;

        for (let dt = start; dt < end; dt = dt.plus({ minutes: slotLength })) {
          const slotKey = dt.toFormat("yyyy-MM-dd'T'HH:mm");

          for (let c = 0; c < capacity; c++) {
            const datetime = dt.toISO({ suppressSeconds: true, suppressMilliseconds: true });
            const slotDescriptor = {
              slotKey,
              sessionId: session.id || null,
              recurringSessionId: session.recurringId || null
            };

            const booking = assignBookingToSlot(slotDescriptor);
            const slotId = buildSlotId({
              sessionKey: session.id || session.recurringId || generateGroupId(session),
              slotKey,
              capacityIndex: c + 1
            });
            const hasActiveBooking = !!booking && ACTIVE_BOOKING_STATUSES.includes(booking.status);

            slots[site_id][date].push({
              slot_id: slotId,
              blocked: hasActiveBooking ? null : (blocksBySlotId.get(slotId) || null),
              datetime,
              slotKey,
              date,
              group: {
                id: generateGroupId(session),
                start: session.from,
                end: session.until
              },
              sessionId: session.id || null,
              recurringSessionId: session.recurringId || null,
              site_id,
              slotLength,
              capacity,
              capacity_index: c + 1,
              services: session.services || [],
              booked: !!booking,
              booking_id: booking ? booking.id : null,
              booking_status: booking ? booking.status : null
            });
          }
        }
      }
    }

    addUnmatchedBookingsToSlots();
  }

  return slots;
}

module.exports = enhanceData;
module.exports.ACTIVE_BOOKING_STATUSES = ACTIVE_BOOKING_STATUSES;
