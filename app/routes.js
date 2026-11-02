const express = require('express');
const router = express.Router();

const { flagsMiddleware } = require('./flags/flags-library');
const { siteLevelMiddleware } = require('./middleware/site-level');

// This prototype has been retired. Every request is answered with the
// sunset page pointing people at its replacement. Remove this block (and
// the DEPRECATED / NEW_PROTOTYPE_URL constants) to bring the prototype
// back to life — the original routes below are left untouched.
const DEPRECATED = process.env.DEPRECATED !== 'false';
const NEW_PROTOTYPE_URL = process.env.NEW_PROTOTYPE_URL
  || 'https://mya-prototype-agentic-06f317b21a54.herokuapp.com/';

if (DEPRECATED) {
  router.use((req, res) => {
    res.status(410).render('deprecated.html', { NEW_PROTOTYPE_URL });
  });
}

router.use(flagsMiddleware());
router.use(siteLevelMiddleware());

// base router AFTER
router.use('/', require('./routes/base'));
router.use('/', require('./routes/change-session'));
router.use('/', require('./routes/cancel-a-date-range'));
router.use('/', require('./routes/block-time'));
router.use('/', require('./routes/block-slots'));
router.use('/', require('./routes/day-schedule'));
router.use('/', require('./routes/design-system-addons'));
router.use('/', require('../map/router'));



module.exports = router;
