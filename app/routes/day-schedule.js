// Alternative version of the day view: a single schedule/diary list with
// filters, instead of separate scheduled / cancelled / blocked tabs.
const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');
const { helpers } = require('./block-slots');

const {
  getToday,
  slotTime,
  isPastSlot,
  isBookedSlot,
  isSelectableSlot,
  blockTag,
  blockLabel
} = helpers;

const STATUS_ORDER = { booked: 0, blocked: 1, available: 2, cancelled: 3 };

router.param('id', (req, res, next, id) => {
  req.site_id = id;
  res.locals.site_id = id;
  next();
});

const toArray = (value) => (Array.isArray(value) ? value : (value ? [value] : []))
  .filter((item) => item && item !== '_unchecked');

// The booked-only filter persists between days; clinic filters are specific to the selected day.
function resolveFilters(req, clinics) {
  const data = req.session.data;

  if (req.query._filter) {
    data.dayScheduleBookedOnly = toArray(req.query._show).includes('booked');
  }

  const clinicIds = new Set(clinics.map((clinic) => clinic.id));

  return {
    bookedOnly: !!data.dayScheduleBookedOnly,
    clinics: toArray(req.query._clinic).filter((id) => clinicIds.has(id))
  };
}

function buildClinics(slots, services) {
  const clinics = new Map();

  for (const slot of slots) {
    if (!slot.group || clinics.has(slot.group.id)) continue;
    clinics.set(slot.group.id, {
      id: slot.group.id,
      from: slot.group.start,
      until: slot.group.end,
      services: (slot.services || []).map((id) => services?.[id]?.name || id)
    });
  }

  const sorted = Array.from(clinics.values()).sort((a, b) => String(a.from).localeCompare(String(b.from)));

  // Add services to the label only where two clinics share the same times.
  for (const clinic of sorted) {
    const label = `${clinic.from} - ${clinic.until} clinic`;
    const shared = sorted.some((other) => other !== clinic && other.from === clinic.from && other.until === clinic.until);
    clinic.label = shared && clinic.services.length ? `${label} (${clinic.services.join(', ')})` : label;
  }

  return sorted;
}

const contactLines = (contact) => Object.entries(contact || {})
  .filter(([, value]) => value)
  .map(([key, value]) => ({ value, primary: key === 'phone' }));

function buildRows({ slots, date, today, data, siteId }) {
  const bookings = data?.bookings?.[siteId] || {};
  const services = data?.services || {};
  const base = `/site/${siteId}/availability/day`;
  const rows = [];

  const serviceName = (serviceId) => services?.[serviceId]?.name || serviceId || '';

  for (const slot of slots) {
    const past = isPastSlot(slot, date, today);
    const from = slotTime(slot);
    const place = slot.capacity > 1 ? `place ${slot.capacity_index} of ${slot.capacity}` : '';
    const common = {
      slotId: slot.slot_id,
      clinicId: slot.group?.id || null,
      datetime: slot.datetime,
      from,
      place,
      past,
      contact: []
    };
    const booking = slot.booking_id ? bookings?.[slot.booking_id] : null;

    if (isBookedSlot(slot)) {
      rows.push({
        ...common,
        status: 'booked',
        patientName: booking?.name || '',
        nhsNumber: booking?.nhsNumber || '',
        contact: contactLines(booking?.contact),
        service: serviceName(booking?.service),
        actions: past ? [] : [
          { text: 'Cancel', href: '/not-in-this-prototype', hidden: `appointment for ${booking?.name || 'patient'} at ${from}` }
        ]
      });
      continue;
    }

    // A cancelled booking frees its slot, so it is listed alongside the slot's current state.
    if (slot.booking_status === 'cancelled') {
      rows.push({
        ...common,
        status: 'cancelled',
        patientName: booking?.name || '',
        nhsNumber: booking?.nhsNumber || '',
        contact: contactLines(booking?.contact),
        service: serviceName(booking?.service),
        actions: []
      });
    }

    if (!slot.group) continue;

    if (slot.blocked) {
      const block = slot.blocked;
      rows.push({
        ...common,
        status: 'blocked',
        blockTag: blockTag(block),
        blockLabel: blockLabel(block),
        contact: block.reason === 'appointment'
          ? contactLines({
            phone: block.appointment?.mobile || block.appointment?.phone,
            landline: block.appointment?.landline,
            email: block.appointment?.email
          })
          : [],
        service: block.reason === 'appointment' ? (block.appointment?.appointmentType || '') : '',
        actions: past ? [] : [
          { text: 'Change', href: '/not-in-this-prototype', hidden: `blocked time at ${from}` },
          {
            text: 'Unblock',
            href: `${base}/unblock?date=${date}&_slot=${encodeURIComponent(slot.slot_id)}&_view=schedule`,
            hidden: `time at ${from}`
          }
        ]
      });
      continue;
    }

    const selectable = isSelectableSlot(slot, date, today);
    rows.push({
      ...common,
      status: 'available',
      selectable,
      service: '',
      actions: selectable ? [
        {
          text: 'Block',
          href: `${base}/block?date=${date}&_view=schedule&_slots=${encodeURIComponent(slot.slot_id)}`,
          hidden: `slot at ${from}${place ? ` (${place})` : ''}`
        }
      ] : []
    });
  }

  rows.sort((a, b) => (
    String(a.datetime || '').localeCompare(String(b.datetime || ''))
    || STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
  ));

  let inputIndex = 0;
  for (const row of rows) {
    if (!row.selectable) continue;
    inputIndex += 1;
    row.inputId = `slot-${inputIndex}`;
  }

  return rows;
}

router.get('/site/:id/availability/day/schedule', (req, res) => {
  const data = req.session.data;
  const siteId = req.site_id;
  const today = getToday(data);
  const date = req.query.date || today;
  const slots = res.locals.slots?.[date] || [];
  const clinics = buildClinics(slots, data.services);
  const filters = resolveFilters(req, clinics);

  const rows = buildRows({ slots, date, today, data, siteId });

  const visibleRows = rows.filter((row) => (
    (!filters.bookedOnly || row.status === 'booked')
    && (!filters.clinics.length || filters.clinics.includes(row.clinicId))
  ));
  const hasClinics = (res.locals.dailyAvailability?.[date]?.sessions || []).length > 0;

  res.render('site/clinics/availability/day-schedule', {
    date,
    today,
    tomorrow: DateTime.fromISO(date).plus({ days: 1 }).toISODate(),
    yesterday: DateTime.fromISO(date).minus({ days: 1 }).toISODate(),
    showFilters: [{
      value: 'booked',
      text: `Booked appointments (${rows.filter((row) => row.status === 'booked').length})`,
      checked: filters.bookedOnly
    }],
    clinicFilters: clinics.length > 1 ? clinics.map((clinic) => ({
      value: clinic.id,
      text: clinic.label,
      checked: filters.clinics.includes(clinic.id)
    })) : [],
    rows: visibleRows,
    hasRows: rows.length > 0,
    hasClinics,
    hasSelectable: visibleRows.some((row) => row.selectable),
    canBlockTime: date >= today && hasClinics,
    blockSlotsBanner: req.flash('blockSlotsBanner')[0] || null
  });
});

module.exports = router;
module.exports.helpers = { buildClinics, resolveFilters };
