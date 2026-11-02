// Block time out of a clinic by entering a time range. Replaces the
// tick-the-slots design in block-slots.js, which is still available with
// the `blockTimeLegacy` flag.
const express = require('express');
const router = express.Router();
const { DateTime } = require('luxon');
const generateGroupId = require('../helpers/groupId');
const { buildCancelledBookingsSummary } = require('../helpers/cancelledBookingsSummary');
const { helpers } = require('./block-slots');

const { getToday, slotTime, isBookedSlot } = helpers;

const REASONS = {
  break: 'A break',
  appointment: 'An appointment',
  other: 'Something else'
};

router.param('id', (req, res, next, id) => {
  req.site_id = id;
  res.locals.site_id = id;
  next();
});

router.use('/site/:id/availability/day/block', (req, res, next) => (
  req.features?.blockTimeLegacy ? next('router') : next()
));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const toArray = (value) => (Array.isArray(value) ? value : (value ? [value] : []))
  .filter((item) => item && item !== '_unchecked');

const getView = (req) => (req.query._view === 'schedule' ? 'schedule' : '');
const viewParam = (view) => (view ? `&_view=${view}` : '');

const dayViewHref = (siteId, date, view = '') => (view === 'schedule'
  ? `/site/${siteId}/availability/day/schedule?date=${date}`
  : `/site/${siteId}/availability/day?date=${date}`);

const stepHref = (req, date, step = '', extra = '') => (
  `/site/${req.site_id}/availability/day/block${step ? `/${step}` : ''}?date=${date}${viewParam(getView(req))}${extra}`
);

const toMinutes = (hhmm) => {
  const [hour, minute] = String(hhmm || '').split(':').map(Number);
  return (hour * 60) + minute;
};

const fromMinutes = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const timeValue = (input = {}) => ({
  hour: String(input.hour ?? '').trim(),
  minute: String(input.minute ?? '').trim()
});

const parseTime = ({ hour, minute }) => {
  if (!hour && !minute) return { empty: true };
  if (!/^\d{1,2}$/.test(hour) || !/^\d{1,2}$/.test(minute || '0')) return { invalid: true };
  const h = Number(hour);
  const m = Number(minute || 0);
  if (h > 23 || m > 59) return { invalid: true };
  return { minutes: (h * 60) + m };
};

const pluralBookings = (count) => `${count} booking${count === 1 ? '' : 's'}`;

function getState(req, date) {
  const state = req.session.data.blockTime;
  return state && state.date === date && String(state.siteId) === String(req.site_id) ? state : null;
}

// One option per clinic running on the day, with its own slot length and capacity.
function getClinics(req, res, date) {
  const data = req.session.data;
  const sessions = res.locals.dailyAvailability?.[date]?.sessions || [];
  const services = data.services || {};
  const clinics = new Map();

  for (const session of sessions) {
    const id = generateGroupId(session);
    if (clinics.has(id)) continue;
    clinics.set(id, {
      id,
      from: session.from,
      until: session.until,
      slotLength: Number(session.slotLength) || 10,
      capacity: Number(session.capacity) || 1,
      services: (session.services || []).map((serviceId) => services?.[serviceId]?.name || serviceId)
    });
  }

  const slotGroups = new Set((res.locals.slots?.[date] || []).filter((slot) => slot.group).map((slot) => slot.group.id));
  const sorted = Array.from(clinics.values())
    .filter((clinic) => slotGroups.has(clinic.id))
    .sort((a, b) => String(a.from).localeCompare(String(b.from)));

  for (const clinic of sorted) {
    const times = `${clinic.from} to ${clinic.until}`;
    clinic.label = clinic.services.length ? `${times} (${clinic.services.join(', ')})` : times;
    clinic.inSentence = `the ${times} clinic`;
  }

  return sorted;
}

// Round the entered times out to whole slots, then pick one place (vaccinator)
// at each slot time. Free places are used first; a booked place is only used
// when every place at that time is booked, which makes the booking affected.
function buildPlan({ slots, clinic, startMinutes, endMinutes, date, today }) {
  const clinicFrom = toMinutes(clinic.from);
  const clinicUntil = toMinutes(clinic.until);
  const length = clinic.slotLength;

  const from = clinicFrom + (Math.floor((startMinutes - clinicFrom) / length) * length);
  const until = Math.min(clinicUntil, clinicFrom + (Math.ceil((endMinutes - clinicFrom) / length) * length));

  const byTime = new Map();
  for (const slot of slots) {
    if (slot.group?.id !== clinic.id) continue;
    const minutes = toMinutes(slotTime(slot));
    if (minutes < from || minutes >= until) continue;
    if (!byTime.has(minutes)) byTime.set(minutes, []);
    byTime.get(minutes).push(slot);
  }

  const slotIds = [];
  const affectedBookingIds = [];
  let pastCount = 0;
  let alreadyBlockedCount = 0;

  for (const minutes of Array.from(byTime.keys()).sort((a, b) => a - b)) {
    const places = byTime.get(minutes).slice().sort((a, b) => b.capacity_index - a.capacity_index);

    // Any slot on today's date can be blocked, including earlier ones.
    if (date < today) {
      pastCount += 1;
      continue;
    }

    const free = places.find((slot) => !isBookedSlot(slot) && !slot.blocked);
    const booked = places.find((slot) => isBookedSlot(slot) && !slot.blocked);

    if (free) {
      slotIds.push(free.slot_id);
    } else if (booked) {
      slotIds.push(booked.slot_id);
      affectedBookingIds.push(String(booked.booking_id));
    } else {
      alreadyBlockedCount += 1;
    }
  }

  return {
    from: fromMinutes(from),
    until: fromMinutes(until),
    rounded: from !== startMinutes || until !== endMinutes,
    slotIds,
    affectedBookingIds,
    pastCount,
    alreadyBlockedCount
  };
}

function summaryFor(state, clinics) {
  const clinic = clinics.find((item) => item.id === state.clinicId);
  return {
    from: state.plan.from,
    until: state.plan.until,
    rounded: state.plan.rounded,
    slotLength: clinic?.slotLength,
    clinicLabel: clinic?.inSentence || '',
    capacity: clinic?.capacity || 1
  };
}

function commit(req, state) {
  const data = req.session.data;
  const siteId = String(req.site_id);
  const groupId = `block-${Date.now()}`;

  data.blocked_slots = data.blocked_slots || {};
  data.blocked_slots[siteId] = Array.isArray(data.blocked_slots[siteId]) ? data.blocked_slots[siteId] : [];

  for (const slotId of state.plan.slotIds) {
    data.blocked_slots[siteId].push({
      slotId,
      date: state.date,
      reason: state.reason,
      name: state.reason === 'appointment' ? '' : state.name,
      note: state.reason === 'other' ? state.name : '',
      appointment: state.reason === 'appointment' ? state.appointment : null,
      groupId,
      from: state.plan.from,
      until: state.plan.until,
      blockedAt: DateTime.now().toISO()
    });
  }

  const siteBookings = data.bookings?.[siteId] || {};
  const affected = state.plan.affectedBookingIds || [];
  const cancelled = state.bookingAction === 'cancel' && affected.length > 0;

  data.blockTimeSuccess = {
    siteId,
    date: state.date,
    view: state.view,
    reason: state.reason,
    from: state.plan.from,
    until: state.plan.until,
    keptCount: state.bookingAction === 'orphan' ? affected.length : 0,
    cancelledBookingsSummary: cancelled
      ? buildCancelledBookingsSummary({ siteBookings, affectedBookingIds: affected, servicesById: data.services })
      : null
  };

  for (const id of affected) {
    if (!siteBookings[id] || !state.bookingAction) continue;
    siteBookings[id].status = state.bookingAction === 'cancel' ? 'cancelled' : 'orphaned';
  }

  delete data.blockTime;
}

// Send the user to the affected bookings step if needed, otherwise save the block.
function finish(req, res, state) {
  if ((state.plan.affectedBookingIds || []).length > 0) {
    return res.redirect(stepHref(req, state.date, 'affected-bookings'));
  }
  commit(req, state);
  return res.redirect(stepHref(req, state.date, 'success'));
}

const detailsStep = (state) => (state.reason === 'appointment' ? 'add-appointment' : 'name');

// -----------------------------------------------------------------------------
// 1. What are you blocking time out for?
// -----------------------------------------------------------------------------
const renderReason = (req, res, { date, state, error }) => res.render('site/clinics/availability/block/reason', {
  date,
  today: getToday(req.session.data),
  reason: state?.reason || '',
  error,
  backHref: dayViewHref(req.site_id, date, getView(req)),
  formAction: stepHref(req, date)
});

router.get('/site/:id/availability/day/block', (req, res) => {
  const data = req.session.data;
  const date = req.query.date || getToday(data);
  const view = getView(req);

  if (date < getToday(data)) return res.redirect(dayViewHref(req.site_id, date, view));

  let state = req.query._back ? getState(req, date) : null;

  if (!state) {
    state = { siteId: String(req.site_id), date, view };

    // Prefill the clinic and times from slots picked in the day view.
    const picked = toArray(req.query._slots);
    const slots = (res.locals.slots?.[date] || []).filter((slot) => picked.includes(slot.slot_id));
    if (slots.length) {
      const times = slots.map((slot) => toMinutes(slotTime(slot)));
      const end = Math.max(...slots.map((slot) => toMinutes(slotTime(slot)) + (Number(slot.slotLength) || 0)));
      const start = fromMinutes(Math.min(...times)).split(':');
      const until = fromMinutes(end).split(':');
      state.clinicId = slots[0].group?.id;
      state.start = { hour: start[0], minute: start[1] };
      state.end = { hour: until[0], minute: until[1] };
    }
    data.blockTime = state;
  }

  renderReason(req, res, { date, state });
});

router.post('/site/:id/availability/day/block', (req, res) => {
  const date = req.query.date || getToday(req.session.data);
  const state = getState(req, date);
  if (!state) return res.redirect(stepHref(req, date));

  const reason = REASONS[req.body._reason] ? req.body._reason : '';
  if (!reason) {
    return renderReason(req, res, { date, state, error: 'Select what you are blocking time out for' });
  }

  state.reason = reason;
  res.redirect(stepHref(req, date, 'time'));
});

// -----------------------------------------------------------------------------
// 2. What time do you want to block out?
// -----------------------------------------------------------------------------
const renderTime = (req, res, { date, state, clinics, errors = [] }) => res.render('site/clinics/availability/block/time', {
  date,
  today: getToday(req.session.data),
  clinics,
  clinicId: state.clinicId || '',
  start: state.start || {},
  end: state.end || {},
  errors,
  errorFor: Object.fromEntries(errors.map((error) => [error.key, error.text])),
  backHref: stepHref(req, date, '', '&_back=1'),
  formAction: stepHref(req, date, 'time')
});

router.get('/site/:id/availability/day/block/time', (req, res) => {
  const date = req.query.date || getToday(req.session.data);
  const state = getState(req, date);
  if (!state?.reason) return res.redirect(stepHref(req, date));

  renderTime(req, res, { date, state, clinics: getClinics(req, res, date) });
});

router.post('/site/:id/availability/day/block/time', (req, res) => {
  const data = req.session.data;
  const date = req.query.date || getToday(data);
  const state = getState(req, date);
  if (!state?.reason) return res.redirect(stepHref(req, date));

  const clinics = getClinics(req, res, date);
  const clinicId = clinics.length === 1 ? clinics[0].id : String(req.body._clinic || '');
  const clinic = clinics.find((item) => item.id === clinicId);

  state.clinicId = clinic ? clinic.id : '';
  state.start = timeValue(req.body._start);
  state.end = timeValue(req.body._end);

  const start = parseTime(state.start);
  const end = parseTime(state.end);
  const errors = [];

  if (!clinic) {
    errors.push({ key: 'clinic', text: 'Select which clinic you want to block time out from', href: '#clinic' });
  }

  if (start.empty) errors.push({ key: 'start', text: 'Enter a start time', href: '#start-time-hour' });
  else if (start.invalid) errors.push({ key: 'start', text: 'Start time must be a real time', href: '#start-time-hour' });

  if (end.empty) errors.push({ key: 'end', text: 'Enter an end time', href: '#end-time-hour' });
  else if (end.invalid) errors.push({ key: 'end', text: 'End time must be a real time', href: '#end-time-hour' });

  const timesValid = start.minutes !== undefined && end.minutes !== undefined;

  if (timesValid && end.minutes <= start.minutes) {
    errors.push({ key: 'end', text: 'End time must be after the start time', href: '#end-time-hour' });
  }

  if (clinic && timesValid && end.minutes > start.minutes) {
    const clinicTimes = `${clinic.from} and ${clinic.until}`;
    if (start.minutes < toMinutes(clinic.from) || start.minutes >= toMinutes(clinic.until)) {
      errors.push({ key: 'start', text: `Start time must be between ${clinicTimes}`, href: '#start-time-hour' });
    }
    if (end.minutes > toMinutes(clinic.until)) {
      errors.push({ key: 'end', text: `End time must be between ${clinicTimes}`, href: '#end-time-hour' });
    }
  }

  if (!errors.length) {
    const plan = buildPlan({
      slots: res.locals.slots?.[date] || [],
      clinic,
      startMinutes: start.minutes,
      endMinutes: end.minutes,
      date,
      today: getToday(data)
    });

    if (plan.slotIds.length === 0) {
      const text = plan.alreadyBlockedCount > 0 && plan.pastCount === 0
        ? 'This time has already been blocked out for every vaccinator'
        : 'Start time must be in the future';
      errors.push({ key: 'start', text, href: '#start-time-hour' });
    } else {
      state.plan = plan;
    }
  }

  if (errors.length) {
    delete state.plan;
    return renderTime(req, res, { date, state, clinics, errors });
  }

  delete state.bookingAction;
  res.redirect(stepHref(req, date, detailsStep(state)));
});

// -----------------------------------------------------------------------------
// 3a. Name the blocked out time (break / something else)
// -----------------------------------------------------------------------------
const renderName = (req, res, { date, state, error }) => res.render('site/clinics/availability/block/name', {
  date,
  required: state.reason === 'other',
  name: state.name || '',
  summary: summaryFor(state, getClinics(req, res, date)),
  error,
  backHref: stepHref(req, date, 'time'),
  formAction: stepHref(req, date, 'name')
});

router.get('/site/:id/availability/day/block/name', (req, res) => {
  const date = req.query.date || getToday(req.session.data);
  const state = getState(req, date);
  if (!state?.plan || state.reason === 'appointment') return res.redirect(stepHref(req, date));

  renderName(req, res, { date, state });
});

router.post('/site/:id/availability/day/block/name', (req, res) => {
  const date = req.query.date || getToday(req.session.data);
  const state = getState(req, date);
  if (!state?.plan || state.reason === 'appointment') return res.redirect(stepHref(req, date));

  state.name = String(req.body._name || '').trim();

  if (state.reason === 'other' && !state.name) {
    return renderName(req, res, { date, state, error: 'Enter a name for the blocked out time' });
  }
  if (!state.name) state.name = 'Break';

  finish(req, res, state);
});

// -----------------------------------------------------------------------------
// 3b. Add an appointment
// -----------------------------------------------------------------------------
const renderAppointment = (req, res, { date, state, values = {}, errors = [] }) => res.render('site/clinics/availability/block/add-appointment', {
  date,
  values,
  summary: summaryFor(state, getClinics(req, res, date)),
  errors,
  errorFor: Object.fromEntries(errors.map((error) => [error.key, error.text])),
  backHref: stepHref(req, date, 'time'),
  formAction: stepHref(req, date, 'add-appointment')
});

router.get('/site/:id/availability/day/block/add-appointment', (req, res) => {
  const date = req.query.date || getToday(req.session.data);
  const state = getState(req, date);
  if (!state?.plan || state.reason !== 'appointment') return res.redirect(stepHref(req, date));

  renderAppointment(req, res, { date, state, values: state.appointmentInput || {} });
});

router.post('/site/:id/availability/day/block/add-appointment', (req, res) => {
  const date = req.query.date || getToday(req.session.data);
  const state = getState(req, date);
  if (!state?.plan || state.reason !== 'appointment') return res.redirect(stepHref(req, date));

  const dobInput = req.body._dob || {};
  const values = {
    appointmentType: String(req.body._appointmentType || '').trim(),
    patientName: String(req.body._patientName || '').trim(),
    dob: {
      day: String(dobInput.day || '').trim(),
      month: String(dobInput.month || '').trim(),
      year: String(dobInput.year || '').trim()
    },
    mobile: String(req.body._mobile || '').trim(),
    landline: String(req.body._landline || '').trim(),
    email: String(req.body._email || '').trim()
  };
  state.appointmentInput = values;

  const errors = [];
  if (!values.appointmentType) {
    errors.push({ key: 'appointmentType', text: 'Enter the appointment type', href: '#appointment-type' });
  }

  const dobEntered = values.dob.day || values.dob.month || values.dob.year;
  const dob = DateTime.fromObject({ day: +values.dob.day, month: +values.dob.month, year: +values.dob.year });
  if (dobEntered && (!dob.isValid || values.dob.year.length !== 4 || dob > DateTime.now())) {
    errors.push({ key: 'dob', text: 'Date of birth must be a real date in the past', href: '#dob-day' });
  }

  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.push({ key: 'email', text: 'Enter an email address in the correct format, like name@example.com', href: '#email' });
  }

  if (errors.length) return renderAppointment(req, res, { date, state, values, errors });

  state.appointment = { ...values, dob: dobEntered ? dob.toISODate() : '' };
  finish(req, res, state);
});

// -----------------------------------------------------------------------------
// 4. Affected bookings (existing pattern)
// -----------------------------------------------------------------------------
router.all('/site/:id/availability/day/block/affected-bookings', (req, res) => {
  const date = req.query.date || getToday(req.session.data);
  const state = getState(req, date);
  const affectedCount = (state?.plan?.affectedBookingIds || []).length;
  if (!state?.plan || !affectedCount) return res.redirect(stepHref(req, date));

  if (req.method === 'POST' && ['orphan', 'cancel'].includes(req.body?.bookingAction)) {
    state.bookingAction = req.body.bookingAction;
    commit(req, state);
    return res.redirect(stepHref(req, date, 'success'));
  }

  res.render('site/clinics/edit/affected-bookings', {
    affectedCount,
    selectedBookingAction: state.bookingAction || null,
    formAction: stepHref(req, date, 'affected-bookings'),
    backHref: stepHref(req, date, detailsStep(state))
  });
});

// -----------------------------------------------------------------------------
// 5. Confirmation (existing pattern)
// -----------------------------------------------------------------------------
router.get('/site/:id/availability/day/block/success', (req, res) => {
  const data = req.session.data;
  const date = req.query.date || getToday(data);
  const success = data.blockTimeSuccess;

  if (!success || success.date !== date || String(success.siteId) !== String(req.site_id)) {
    return res.redirect(dayViewHref(req.site_id, date, getView(req)));
  }

  const subject = success.reason === 'appointment' ? 'Appointment added' : 'Time blocked out';
  const nextActions = [
    { href: dayViewHref(req.site_id, date, success.view), text: 'Back to day view' },
    { href: stepHref(req, date), text: 'Block out more time' }
  ];
  const summary = success.cancelledBookingsSummary;

  res.render('site/clinics/edit/success', {
    titleText: subject,
    primaryHref: nextActions[0].href,
    primaryText: nextActions[0].text,
    secondaryHref: nextActions[1].href,
    secondaryText: nextActions[1].text,
    cancelSummary: summary ? {
      titleText: `${subject} and ${pluralBookings(summary.cancelledCount)} cancelled`,
      cancelledCount: summary.cancelledCount,
      unnotifiedCount: summary.unnotifiedCount,
      unnotifiedBookings: summary.unnotifiedBookings,
      nextActions
    } : null
  });
});

module.exports = router;
