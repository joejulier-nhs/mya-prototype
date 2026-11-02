const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');
const { ACTIVE_BOOKING_STATUSES } = require('../helpers/enhanceData');

const TIMEZONE = 'Europe/London';
const REASONS = {
  break: 'Break',
  appointment: 'Appointment',
  other: 'Something else'
};

router.param('id', (req, res, next, id) => {
  req.site_id = id;
  res.locals.site_id = id;
  next();
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const toArray = (value) => (Array.isArray(value) ? value : (value ? [value] : []))
  .filter((item) => item && item !== '_unchecked');

const getToday = (data) => data?.today
  || process.env.OVERRIDE_TODAY
  || DateTime.now().setZone(TIMEZONE).toFormat('yyyy-MM-dd');

// `_view=schedule` returns the user to the schedule version of the day view.
const getView = (req) => (req.query._view === 'schedule' ? 'schedule' : '');
const viewParam = (view) => (view ? `&_view=${view}` : '');

const dayViewHref = (siteId, date, view = '') => (view === 'schedule'
  ? `/site/${siteId}/availability/day/schedule?date=${date}`
  : `/site/${siteId}/availability/day?date=${date}`);
const blockHref = (siteId, date, view = '') => `/site/${siteId}/availability/day/block?date=${date}${viewParam(view)}`;

const slotTime = (slot) => DateTime.fromISO(slot.datetime, { zone: TIMEZONE }).toFormat('HH:mm');

const slotEndTime = (slot) => DateTime.fromISO(slot.datetime, { zone: TIMEZONE })
  .plus({ minutes: Number(slot.slotLength) || 0 })
  .toFormat('HH:mm');

const isPastSlot = (slot, date, today) => {
  if (date < today) return true;
  if (date > today) return false;
  return slotTime(slot) < DateTime.now().setZone(TIMEZONE).toFormat('HH:mm');
};

const isBookedSlot = (slot) => ACTIVE_BOOKING_STATUSES.includes(slot.booking_status);

const isSelectableSlot = (slot, date, today) => (
  !!slot.group && !isBookedSlot(slot) && !slot.blocked && !isPastSlot(slot, date, today)
);

const pluralSlots = (count) => `${count} slot${count === 1 ? '' : 's'}`;

// Group the day's slots by clinic, keeping each capacity place as its own row.
function buildClinicGroups({ slots, date, today, data, siteId }) {
  const groups = new Map();
  const bookings = data?.bookings?.[siteId] || {};
  const services = data?.services || {};

  for (const slot of slots) {
    if (!slot.group || isPastSlot(slot, date, today)) continue;

    if (!groups.has(slot.group.id)) {
      groups.set(slot.group.id, {
        id: slot.group.id,
        from: slot.group.start,
        until: slot.group.end,
        rows: []
      });
    }

    const booking = isBookedSlot(slot) ? bookings?.[slot.booking_id] : null;

    groups.get(slot.group.id).rows.push({
      id: slot.slot_id,
      from: slotTime(slot),
      until: slotEndTime(slot),
      capacity: slot.capacity,
      capacityIndex: slot.capacity_index,
      status: isBookedSlot(slot) ? 'booked' : (slot.blocked ? 'blocked' : 'available'),
      patientName: booking?.name || '',
      serviceName: booking ? (services?.[booking.service]?.name || booking.service || '') : '',
      blockedTag: slot.blocked ? blockTag(slot.blocked) : '',
      blockedLabel: slot.blocked ? blockLabel(slot.blocked) : ''
    });
  }

  const clinics = Array.from(groups.values()).sort((a, b) => String(a.from).localeCompare(String(b.from)));

  let inputIndex = 0;
  for (const clinic of clinics) {
    for (const row of clinic.rows) {
      if (row.status !== 'available') continue;
      row.inputId = inputIndex === 0 ? 'slots' : `slots-${inputIndex + 1}`;
      inputIndex += 1;
    }
  }

  return clinics;
}

function blockTag(block) {
  return block.reason === 'appointment' ? 'Blocked - appointment' : 'Blocked';
}

function blockLabel(block) {
  if (block.reason === 'appointment') return block.appointment?.patientName || block.appointment?.appointmentType || '';
  if (block.name) return block.name;
  if (block.reason === 'other') return block.note || REASONS.other;
  return REASONS[block.reason] || REASONS.other;
}

function getSelectableIds(slots, date, today) {
  return new Set(slots.filter((slot) => isSelectableSlot(slot, date, today)).map((slot) => slot.slot_id));
}

function commitBlocks({ req, date, slotIds, reason, note, appointment }) {
  const data = req.session.data;
  const siteId = String(req.site_id);

  data.blocked_slots = data.blocked_slots || {};
  data.blocked_slots[siteId] = Array.isArray(data.blocked_slots[siteId]) ? data.blocked_slots[siteId] : [];

  for (const slotId of slotIds) {
    data.blocked_slots[siteId].push({
      slotId,
      date,
      reason,
      note: reason === 'other' ? (note || '') : '',
      appointment: reason === 'appointment' ? appointment : null,
      blockedAt: DateTime.now().toISO()
    });
  }

  delete data.blockSlotsPending;

  req.flash('blockSlotsBanner', `${pluralSlots(slotIds.length)} blocked`);
}

function renderSelectPage(req, res, { date, errors = [], selected = [], reason = '', note = '' }) {
  const today = getToday(req.session.data);
  const view = getView(req);
  const slots = res.locals.slots?.[date] || [];
  const clinics = buildClinicGroups({ slots, date, today, data: req.session.data, siteId: req.site_id });

  res.render('site/clinics/availability/block/select', {
    date,
    today,
    clinics,
    errors,
    errorFor: Object.fromEntries(errors.map((error) => [error.key, error.text])),
    selected,
    reason,
    note,
    backHref: dayViewHref(req.site_id, date, view),
    formAction: blockHref(req.site_id, date, view)
  });
}

// -----------------------------------------------------------------------------
// Select slots to block
// -----------------------------------------------------------------------------
router.get('/site/:id/availability/day/block', (req, res) => {
  const data = req.session.data;
  const date = req.query.date || getToday(data);
  const view = getView(req);

  if (date < getToday(data)) {
    return res.redirect(dayViewHref(req.site_id, date, view));
  }

  // Prefill only when returning from the appointment details page via its back link.
  if (!req.query._back) delete data.blockSlotsPending;
  const pending = data.blockSlotsPending?.date === date ? data.blockSlotsPending : null;

  renderSelectPage(req, res, {
    date,
    selected: pending?.slotIds || toArray(req.query._slots),
    reason: pending ? 'appointment' : ''
  });
});

router.post('/site/:id/availability/day/block', (req, res) => {
  const data = req.session.data;
  const date = req.query.date || getToday(data);
  const today = getToday(data);
  const view = getView(req);
  const selectableIds = getSelectableIds(res.locals.slots?.[date] || [], date, today);

  const slotIds = toArray(req.body._slots).filter((id) => selectableIds.has(id));
  const reason = REASONS[req.body._reason] ? req.body._reason : '';
  const note = String(req.body._note || '').trim();

  const errors = [];
  if (slotIds.length === 0) {
    errors.push({ key: 'slots', text: 'Select at least one slot to block', href: '#slots' });
  }
  if (!reason) {
    errors.push({ key: 'reason', text: 'Select what you are blocking this time for', href: '#block-reason' });
  }

  if (errors.length) {
    return renderSelectPage(req, res, { date, errors, selected: slotIds, reason, note });
  }

  if (reason === 'appointment') {
    data.blockSlotsPending = { date, slotIds };
    return res.redirect(`/site/${req.site_id}/availability/day/block/appointment?date=${date}${viewParam(view)}`);
  }

  commitBlocks({ req, date, slotIds, reason, note });
  res.redirect(dayViewHref(req.site_id, date, view));
});

// -----------------------------------------------------------------------------
// Appointment details
// -----------------------------------------------------------------------------
const renderAppointmentPage = (req, res, { date, pending, errors = [], values = {} }) => {
  const view = getView(req);
  res.render('site/clinics/availability/block/appointment', {
    date,
    slotCount: pending.slotIds.length,
    errors,
    errorFor: Object.fromEntries(errors.map((error) => [error.key, error.text])),
    values,
    backHref: `${blockHref(req.site_id, date, view)}&_back=1`,
    formAction: `/site/${req.site_id}/availability/day/block/appointment?date=${date}${viewParam(view)}`
  });
};

router.get('/site/:id/availability/day/block/appointment', (req, res) => {
  const data = req.session.data;
  const date = req.query.date || getToday(data);
  const pending = data.blockSlotsPending?.date === date ? data.blockSlotsPending : null;

  if (!pending) return res.redirect(blockHref(req.site_id, date, getView(req)));

  renderAppointmentPage(req, res, { date, pending });
});

router.post('/site/:id/availability/day/block/appointment', (req, res) => {
  const data = req.session.data;
  const date = req.query.date || getToday(data);
  const pending = data.blockSlotsPending?.date === date ? data.blockSlotsPending : null;
  const view = getView(req);

  if (!pending) return res.redirect(blockHref(req.site_id, date, view));

  const dobInput = req.body._dob || {};
  const values = {
    appointmentType: String(req.body._appointmentType || '').trim(),
    patientName: String(req.body._patientName || '').trim(),
    dob: {
      day: String(dobInput.day || '').trim(),
      month: String(dobInput.month || '').trim(),
      year: String(dobInput.year || '').trim()
    },
    phone: String(req.body._phone || '').trim(),
    email: String(req.body._email || '').trim()
  };

  const errors = [];
  if (!values.appointmentType) {
    errors.push({ key: 'appointmentType', text: 'Enter the appointment type', href: '#appointment-type' });
  }

  const dobEntered = values.dob.day || values.dob.month || values.dob.year;
  const dob = DateTime.fromObject({ day: +values.dob.day, month: +values.dob.month, year: +values.dob.year });
  if (dobEntered && (!dob.isValid || values.dob.year.length !== 4 || dob > DateTime.now())) {
    errors.push({ key: 'dob', text: 'Date of birth must be a real date in the past', href: '#dob-day' });
  }

  if (errors.length) {
    return renderAppointmentPage(req, res, { date, pending, errors, values });
  }

  values.dob = dobEntered ? dob.toISODate() : '';

  // Slots may have been booked or blocked since they were selected.
  const selectableIds = getSelectableIds(res.locals.slots?.[date] || [], date, getToday(data));
  const slotIds = pending.slotIds.filter((id) => selectableIds.has(id));

  if (slotIds.length === 0) {
    delete data.blockSlotsPending;
    return res.redirect(blockHref(req.site_id, date, view));
  }

  commitBlocks({ req, date, slotIds, reason: 'appointment', appointment: values });
  res.redirect(dayViewHref(req.site_id, date, view));
});

// -----------------------------------------------------------------------------
// Undo a blocked slot
// -----------------------------------------------------------------------------
router.get('/site/:id/availability/day/unblock', (req, res) => {
  const data = req.session.data;
  const siteId = String(req.site_id);
  const date = req.query.date || getToday(data);
  const slotId = String(req.query._slot || '');
  const blocks = Array.isArray(data.blocked_slots?.[siteId]) ? data.blocked_slots[siteId] : [];
  const index = blocks.findIndex((block) => block.slotId === slotId);

  if (index !== -1) {
    blocks.splice(index, 1);
    const time = slotId.split('|')[1]?.split('T')[1];
    req.flash('blockSlotsBanner', time ? `Slot at ${time} is available again` : 'Slot is available again');
  }

  res.redirect(dayViewHref(req.site_id, date, getView(req)));
});

module.exports = router;
module.exports.helpers = {
  getToday,
  slotTime,
  slotEndTime,
  isPastSlot,
  isBookedSlot,
  isSelectableSlot,
  blockTag,
  blockLabel
};
