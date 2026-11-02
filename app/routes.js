const express = require('express');
const router = express.Router();

const { flagsMiddleware } = require('./flags/flags-library');
const { siteLevelMiddleware } = require('./middleware/site-level');

// Set DEPRECATED=true to show the sunset page instead of the prototype.
const DEPRECATED = process.env.DEPRECATED === 'true';
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
