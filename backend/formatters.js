// These helpers format plain DB rows into shapes that match
// the Sharetribe Flex API response structure.
// The frontend Redux ducks already know how to parse this shape,
// so keeping it compatible means zero frontend changes.

const formatMoney = (amount, currency = 'USD') => ({
  _sdkType: 'Money',
  amount,
  currency,
});

const formatUUID = (id) => ({ _sdkType: 'UUID', uuid: id });

const formatUser = (user) => ({
  id: formatUUID(user.id),
  type: 'user',
  attributes: {
    banned: false,
    deleted: false,
    createdAt: user.created_at,
    email: user.email,
    emailVerified: user.email_verified,
    profile: {
      firstName: user.first_name,
      lastName: user.last_name,
      displayName: user.display_name || `${user.first_name} ${user.last_name}`.trim(),
      abbreviatedName: `${(user.first_name || '')[0] || ''}${(user.last_name || '')[0] || ''}`,
      bio: user.bio,
      publicData: {
        userType: user.user_type,
        ...(user.public_data || {}),
      },
      privateData: user.private_data || {},
      metadata: user.metadata || {},
      avatar: user.avatar_url ? { _sdkType: 'ImageRef', url: user.avatar_url } : null,
    },
    stripeConnected: !!user.stripe_account_id,
    stripeAccountData: user.stripe_account_id
      ? { stripeAccountId: user.stripe_account_id, stripeAccountReady: user.stripe_account_ready }
      : null,
  },
});

const formatCurrentUser = (user) => ({
  ...formatUser(user),
  type: 'currentUser',
  attributes: {
    ...formatUser(user).attributes,
    email: user.email,
    emailVerified: user.email_verified,
  },
});

const formatListing = (listing, author = null) => {
  const obj = {
    id: formatUUID(listing.id),
    type: 'listing',
    attributes: {
      title: listing.title,
      description: listing.description,
      deleted: false,
      geolocation: listing.location_lat
        ? { _sdkType: 'LatLng', lat: listing.location_lat, lng: listing.location_lng }
        : null,
      createdAt: listing.created_at,
      state: listing.state,
      price: listing.price_amount != null
        ? formatMoney(listing.price_amount, listing.price_currency)
        : null,
      availabilityPlan: null,
      publicData: {
        category: listing.category,
        classDuration: listing.class_duration,
        weeklyDays: listing.weekly_days || [],
        paymentType: listing.payment_type || [],
        timezone: listing.timezone,
        startDate: listing.start_date,
        endDate: listing.end_date,
        startDateString: listing.start_date_string,
        nextClass: listing.next_class,
        lastClass: listing.last_class,
        stock: listing.stock,
        priceId: listing.price_id,
        type: listing.listing_type,
        monthlyPrice: listing.monthly_price,
        location: listing.location_address ? { address: listing.location_address } : null,
        ...(listing.public_data || {}),
      },
      privateData: {
        zoom: listing.zoom_data || {},
        ...(listing.private_data || {}),
      },
      metadata: {},
    },
    relationships: {},
  };

  if (author) {
    obj.relationships.author = { data: { id: formatUUID(author.id), type: 'user' } };
  }

  // Images
  const images = Array.isArray(listing.images) ? listing.images : [];
  if (images.length > 0) {
    obj.relationships.images = {
      data: images.map((url, i) => ({ id: formatUUID(`${listing.id}-img-${i}`), type: 'image' })),
    };
    obj._imageData = images.map((url, i) => ({
      id: formatUUID(`${listing.id}-img-${i}`),
      type: 'image',
      attributes: {
        variants: {
          'landscape-crop': { url, width: 400, height: 267, name: 'landscape-crop' },
          'landscape-crop2x': { url, width: 800, height: 533, name: 'landscape-crop2x' },
          'scaled-small': { url, width: 320, height: 320, name: 'scaled-small' },
          'scaled-medium': { url, width: 750, height: 750, name: 'scaled-medium' },
          'scaled-large': { url, width: 1024, height: 1024, name: 'scaled-large' },
          'scaled-xlarge': { url, width: 2400, height: 2400, name: 'scaled-xlarge' },
        },
      },
    }));
  }

  return obj;
};

const formatTransaction = (tx, listing = null, customer = null, provider = null) => ({
  id: formatUUID(tx.id),
  type: 'transaction',
  attributes: {
    createdAt: tx.created_at,
    processName: tx.process_name || 'flex-hourly-default-process',
    processVersion: 1,
    lastTransition: tx.last_transition || tx.status,
    lastTransitionedAt: tx.updated_at,
    transitions: [],
    payinTotal: tx.total_amount != null ? formatMoney(tx.total_amount, tx.price_currency) : null,
    payoutTotal: tx.provider_payout != null ? formatMoney(tx.provider_payout, tx.price_currency) : null,
    lineItems: [],
    metadata: tx.metadata || {},
    protectedData: {},
  },
  relationships: {
    listing: listing ? { data: { id: formatUUID(listing.id), type: 'listing' } } : undefined,
    customer: customer ? { data: { id: formatUUID(customer.id), type: 'user' } } : undefined,
    provider: provider ? { data: { id: formatUUID(provider.id), type: 'user' } } : undefined,
    booking: tx.booking_start ? {
      data: { id: formatUUID(`${tx.id}-booking`), type: 'booking' },
    } : undefined,
  },
});

const formatBooking = (tx) => ({
  id: formatUUID(`${tx.id}-booking`),
  type: 'booking',
  attributes: {
    start: tx.booking_start,
    end: tx.booking_end,
    displayStart: tx.booking_start,
    displayEnd: tx.booking_end,
    seats: tx.seats || 1,
    state: tx.status,
  },
});

// Builds the standard Flex API response envelope
const buildResponse = (data, included = [], meta = {}) => ({
  data,
  included,
  meta,
});

module.exports = {
  formatUser,
  formatCurrentUser,
  formatListing,
  formatTransaction,
  formatBooking,
  formatMoney,
  formatUUID,
  buildResponse,
};
