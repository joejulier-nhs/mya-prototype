const { DateTime } = require('luxon');
const { ACTIVE_BOOKING_STATUSES } = require('./enhanceData');

const TIMEZONE = 'Europe/London';
const STATUS_ORDER = { booked: 0, blocked: 1, available: 2, cancelled: 3 };

const slotTime = (slot) => DateTime.fromISO(slot.datetime, { zone: TIMEZONE }).toFormat('HH:mm');

// One row per slot place for the day view: booked, blocked, available or a
// cancelled booking. A cancelled booking frees its place, so it takes the place
// of the "Available" row unless the place has since been blocked.
function buildDayRows({ slots, date, today, siteId, bookings }) {
  const rows = [];
  const pastDay = date < today;

  for (const slot of slots) {
    const time = slotTime(slot);
    const booking = slot.booking_id ? bookings?.[slot.booking_id] || null : null;
    const common = {
      slot,
      booking,
      time,
      datetime: slot.datetime,
      clinicId: slot.group?.id || null,
      blockTimeHref: pastDay || !slot.group
        ? null
        : `/site/${siteId}/availability/day/block?date=${date}&_slots=${encodeURIComponent(slot.slot_id)}`
    };

    if (ACTIVE_BOOKING_STATUSES.includes(slot.booking_status)) {
      rows.push({ ...common, status: 'booked', blockTimeHref: null });
      continue;
    }

    if (slot.blocked) {
      if (slot.booking_status === 'cancelled') {
        rows.push({ ...common, status: 'cancelled', blockTimeHref: null });
      }
      rows.push({ ...common, status: 'blocked', blockTimeHref: null });
      continue;
    }

    if (slot.booking_status === 'cancelled') {
      rows.push({ ...common, status: 'cancelled' });
      continue;
    }

    if (slot.group) rows.push({ ...common, status: 'available' });
  }

  return rows.sort((a, b) => (
    String(a.datetime || '').localeCompare(String(b.datetime || ''))
    || STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  ));
}

module.exports = { buildDayRows };
