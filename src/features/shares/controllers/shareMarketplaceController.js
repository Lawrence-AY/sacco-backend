const { Op } = require('sequelize');
const db = require('../../../models');
const asyncHandler = require('../../../shared/utils/asyncHandler');
const ResponseHandler = require('../../../shared/utils/response');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../../shared/utils/errors');
const logger = require('../../../shared/utils/logger');

/**
 * Create a share capital listing (sellers who opt out)
 */
const createListing = asyncHandler(async (req, res) => {
  const member = await db.Member.findOne({ where: { userId: req.user.id } });
  if (!member) {
    throw new NotFoundError('Member profile not found');
  }

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    throw new ValidationError('A valid share capital amount is required.');
  }

  // Check for existing active listing
  const activeListing = await db.ShareCapitalListing.findOne({
    where: { memberId: member.id, status: { [Op.in]: ['ACTIVE', 'LOCKED'] } },
  });
  if (activeListing) {
    throw new ValidationError('You already have an active share capital listing.');
  }

  const listing = await db.ShareCapitalListing.create({
    memberId: member.id,
    amount,
    status: 'ACTIVE',
  });

  return ResponseHandler.created(res, {
    id: listing.id,
    memberId: listing.memberId,
    amount: listing.amount,
    status: listing.status,
    createdAt: listing.createdAt,
  }, 'Share capital listing created successfully.');
});

/**
 * Get all active share capital listings (viewable by MEMBER, ADMIN, FINANCE)
 */
const getListings = asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) {
    where.status = req.query.status;
  } else {
    where.status = { [Op.in]: ['ACTIVE', 'LOCKED'] };
  }

  const listings = await db.ShareCapitalListing.findAll({
    where,
    include: [
      {
        model: db.Member,
        attributes: ['id', 'memberNumber'],
        include: [{ model: db.User, attributes: ['id', 'name', 'email'] }],
      },
      {
        model: db.Bid,
        where: { status: 'PENDING' },
        required: false,
        attributes: ['id', 'amount', 'bidderMemberNumber', 'bidderName', 'createdAt'],
      },
    ],
    order: [['createdAt', 'DESC']],
  });

  const formatted = listings.map((listing) => ({
    id: listing.id,
    memberId: listing.memberId,
    sellerMemberNumber: listing.Member?.memberNumber || 'N/A',
    sellerName: listing.Member?.User?.name || 'Unknown',
    amount: listing.amount,
    status: listing.status,
    bidCount: listing.Bids?.length || 0,
    bids: listing.Bids || [],
    createdAt: listing.createdAt,
  }));

  return ResponseHandler.success(res, formatted, 'Share capital listings retrieved.');
});

/**
 * Get a single listing with all bids
 */
const getListingById = asyncHandler(async (req, res) => {
  const listing = await db.ShareCapitalListing.findByPk(req.params.listingId, {
    include: [
      { model: db.Member, attributes: ['id', 'memberNumber'], include: [{ model: db.User, attributes: ['id', 'name', 'email'] }] },
      { model: db.Bid, order: [['amount', 'DESC']] },
    ],
  });

  if (!listing) {
    throw new NotFoundError('Listing not found.');
  }

  return ResponseHandler.success(res, {
    id: listing.id,
    memberId: listing.memberId,
    sellerMemberNumber: listing.Member?.memberNumber,
    sellerName: listing.Member?.User?.name,
    amount: listing.amount,
    status: listing.status,
    bids: listing.Bids || [],
    selectedBidId: listing.selectedBidId,
    createdAt: listing.createdAt,
  }, 'Listing retrieved.');
});

/**
 * Place a bid on a share capital listing
 */
const placeBid = asyncHandler(async (req, res) => {
  const listing = await db.ShareCapitalListing.findByPk(req.params.listingId);
  if (!listing) throw new NotFoundError('Listing not found.');
  if (listing.status !== 'ACTIVE') {
    throw new ValidationError('This listing is no longer accepting bids.');
  }

  const member = await db.Member.findOne({ where: { userId: req.user.id } });
  if (!member) throw new NotFoundError('Member profile not found.');

  // Prevent seller from bidding on own listing
  if (listing.memberId === member.id) {
    throw new ValidationError('You cannot bid on your own listing.');
  }

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) {
    throw new ValidationError('A valid bid amount is required.');
  }
  if (amount > listing.amount) {
    throw new ValidationError(`Bid amount cannot exceed the listing amount of KES ${listing.amount.toLocaleString()}.`);
  }

  // Check for existing pending bid from this bidder
  const existingBid = await db.Bid.findOne({
    where: { listingId: listing.id, bidderId: member.id, status: 'PENDING' },
  });
  if (existingBid) {
    // Update existing bid
    await existingBid.update({ amount });
    return ResponseHandler.success(res, {
      id: existingBid.id,
      listingId: existingBid.listingId,
      amount: existingBid.amount,
      status: existingBid.status,
    }, 'Your bid has been updated.');
  }

  const bid = await db.Bid.create({
    listingId: listing.id,
    bidderId: member.id,
    bidderMemberNumber: member.memberNumber || '',
    bidderName: req.user.name || '',
    amount,
  });

  return ResponseHandler.created(res, {
    id: bid.id,
    listingId: bid.listingId,
    amount: bid.amount,
    status: bid.status,
    createdAt: bid.createdAt,
  }, 'Bid placed successfully.');
});

/**
 * Seller accepts a bid (selects preferred bidder)
 */
const acceptBid = asyncHandler(async (req, res) => {
  const listing = await db.ShareCapitalListing.findByPk(req.params.listingId);
  if (!listing) throw new NotFoundError('Listing not found.');

  const member = await db.Member.findOne({ where: { userId: req.user.id } });
  if (!member) throw new NotFoundError('Member profile not found.');
  if (listing.memberId !== member.id) {
    throw new ForbiddenError('Only the listing owner can accept bids.');
  }
  if (listing.status !== 'ACTIVE') {
    throw new ValidationError('This listing is not in an actionable state.');
  }

  const bid = await db.Bid.findByPk(req.params.bidId);
  if (!bid || bid.listingId !== listing.id) {
    throw new NotFoundError('Bid not found for this listing.');
  }
  if (bid.status !== 'PENDING') {
    throw new ValidationError('This bid has already been processed.');
  }

  const settledPrice = bid.amount;
  // Financial rule: Management Fee = S × 0.01 (1%)
  const managementFee = Math.round(settledPrice * 0.01 * 100) / 100;
  const sellerPayout = settledPrice - managementFee;

  // Lock the listing
  await db.sequelize.transaction(async (t) => {
    await listing.update({
      status: 'LOCKED',
      selectedBidId: bid.id,
      settledPrice,
      managementFee,
      sellerPayout,
      buyerMemberNumber: bid.bidderMemberNumber,
    }, { transaction: t });

    await bid.update({ status: 'ACCEPTED', acceptedAt: new Date() }, { transaction: t });

    // Reject all other bids
    await db.Bid.update(
      { status: 'REJECTED' },
      { where: { listingId: listing.id, id: { [Op.ne]: bid.id }, status: 'PENDING' }, transaction: t }
    );

    // Create transfer transaction for the seller payout
    await db.Transaction.create({
      memberId: listing.memberId,
      type: 'SHARE_CAPITAL_SELL',
      amount: sellerPayout,
      method: 'INTERNAL',
      status: 'SUCCESS',
      reference: `SELL-${listing.id.slice(0, 8)}`,
      description: `Share capital sale payout (1% SACCO fee: KES ${managementFee.toLocaleString()})`,
    }, { transaction: t });

    // Create fee revenue transaction for SACCO management
    await db.Transaction.create({
      memberId: listing.memberId,
      type: 'MANAGEMENT_FEE',
      amount: managementFee,
      method: 'INTERNAL',
      status: 'SUCCESS',
      reference: `FEE-${listing.id.slice(0, 8)}`,
      description: `1% SACCO management fee on share capital sale of KES ${settledPrice.toLocaleString()}`,
    }, { transaction: t });

    // Mark the listing as completed
    await listing.update({
      status: 'COMPLETED',
      completedAt: new Date(),
    }, { transaction: t });

    // Mark the opting-out member as inactive
    await db.Member.update(
      { isVerified: false },
      { where: { id: listing.memberId }, transaction: t }
    );

    // Deactivate the member's user account
    const listingMember = await db.Member.findByPk(listing.memberId, { transaction: t });
    if (listingMember) {
      await db.User.update(
        { isActive: false },
        { where: { id: listingMember.userId }, transaction: t }
      );
    }
  });

  return ResponseHandler.success(res, {
    settledPrice,
    managementFee,
    sellerPayout,
    listingStatus: 'COMPLETED',
    buyerMemberNumber: bid.bidderMemberNumber,
  }, 'Bid accepted. Transaction processed with 1% SACCO management fee.');
});

/**
 * Get bids for the seller's own listings
 */
const getMyListingBids = asyncHandler(async (req, res) => {
  const member = await db.Member.findOne({ where: { userId: req.user.id } });
  if (!member) throw new NotFoundError('Member profile not found.');

  const listings = await db.ShareCapitalListing.findAll({
    where: { memberId: member.id },
    include: [{ model: db.Bid, order: [['amount', 'DESC']] }],
    order: [['createdAt', 'DESC']],
  });

  const formatted = listings.map((listing) => ({
    id: listing.id,
    amount: listing.amount,
    status: listing.status,
    settledPrice: listing.settledPrice,
    managementFee: listing.managementFee,
    sellerPayout: listing.sellerPayout,
    buyerMemberNumber: listing.buyerMemberNumber,
    bids: (listing.Bids || []).map((bid) => ({
      id: bid.id,
      amount: bid.amount,
      bidderName: bid.bidderName,
      bidderMemberNumber: bid.bidderMemberNumber,
      status: bid.status,
      createdAt: bid.createdAt,
    })),
    createdAt: listing.createdAt,
  }));

  return ResponseHandler.success(res, formatted, 'Your listings and bids retrieved.');
});

module.exports = {
  createListing,
  getListings,
  getListingById,
  placeBid,
  acceptBid,
  getMyListingBids,
};