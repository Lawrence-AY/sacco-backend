const express = require('express');

const { protect, authorize } = require('../../../shared/middleware/authMiddleware');
const shareController = require('../controllers/shareController');
const marketplaceController = require('../controllers/shareMarketplaceController');

const router = express.Router();

router.use(protect);

// Share account routes
router.get('/', authorize(['ADMIN', 'FINANCE', 'MEMBER', 'EMPLOYEE']), shareController.getShares);

// Marketplace routes — share capital listings & bids
router.post('/listings', authorize(['MEMBER', 'EMPLOYEE', 'ADMIN']), marketplaceController.createListing);
router.get('/listings', authorize(['MEMBER', 'EMPLOYEE', 'ADMIN', 'FINANCE']), marketplaceController.getListings);
router.get('/listings/my-bids', authorize(['MEMBER', 'EMPLOYEE']), marketplaceController.getMyListingBids);
router.get('/listings/:listingId', authorize(['MEMBER', 'EMPLOYEE', 'ADMIN', 'FINANCE']), marketplaceController.getListingById);
router.post('/listings/:listingId/bids', authorize(['MEMBER', 'EMPLOYEE', 'ADMIN']), marketplaceController.placeBid);
router.post('/listings/:listingId/bids/:bidId/accept', authorize(['MEMBER', 'EMPLOYEE']), marketplaceController.acceptBid);

module.exports = router;
