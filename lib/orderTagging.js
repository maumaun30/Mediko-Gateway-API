// Moved verbatim from index.js.
const { queryAsync } = require("./db");
const { log } = require("./log");
const { shopifyGraphQL, throwIfUserErrors } = require("./shopifyAdmin");

const ORDER_TAGS = ["PWD", "SC"];

// Refunds are a second, independent axis: an order stays PWD or SC and gains
// this tag once management has processed the refund by hand in Shopify.
const REFUND_TAG = "REFUNDED";

// Search terms are interpolated into a Shopify query string, where a quote or
// backslash would break out of it. Neither carries meaning in a search, so drop
// them rather than escaping.
function sanitizeSearchTerm(term) {
  return String(term).replace(/["\\]/g, " ").trim();
}

// Without a search term, lists the applicant's own orders by email. With one,
// hands it to Shopify's default order search, which spans order name, email
// and customer name — an applicant's discount may sit on an order placed under
// someone else's address.
async function listOrders({ email, search }) {
  const term =
    typeof search === "string" ? sanitizeSearchTerm(search).slice(0, 100) : "";
  const q = term ? term : `email:"${sanitizeSearchTerm(email)}"`;

  const data = await shopifyGraphQL(
    `query customerOrders($q: String!) {
       orders(first: 20, query: $q, sortKey: CREATED_AT, reverse: true) {
         edges {
           node {
             id
             name
             email
             createdAt
             tags
             displayFinancialStatus
             customer { id displayName }
             currentTotalPriceSet { shopMoney { amount currencyCode } }
           }
         }
       }
     }`,
    { q },
  );

  return (data?.orders?.edges || []).map(({ node }) => ({
    gid: node.id,
    name: node.name,
    email: node.email || null,
    customer_gid: node.customer?.id || null,
    customer_name: node.customer?.displayName || null,
    created_at: node.createdAt,
    tags: node.tags || [],
    financial_status: node.displayFinancialStatus,
    total: node.currentTotalPriceSet?.shopMoney?.amount || null,
    currency: node.currentTotalPriceSet?.shopMoney?.currencyCode || null,
  }));
}

async function addShopifyTag(gid, tag) {
  const data = await shopifyGraphQL(
    `mutation addTags($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) {
         node { id }
         userErrors { field message }
       }
     }`,
    { id: gid, tags: [tag] },
  );
  throwIfUserErrors(data?.tagsAdd?.userErrors, "tagsAdd");
}

async function removeShopifyTag(gid, tag) {
  const data = await shopifyGraphQL(
    `mutation removeTags($id: ID!, $tags: [String!]!) {
       tagsRemove(id: $id, tags: $tags) {
         node { id }
         userErrors { field message }
       }
     }`,
    { id: gid, tags: [tag] },
  );
  throwIfUserErrors(data?.tagsRemove?.userErrors, "tagsRemove");
}

// One Shopify customer can back several applications (a household sharing an
// email, a re-application). Only strip their tag once no other row still needs
// it, otherwise unassigning one application silently downgrades the others.
async function untagCustomerIfUnused(id, customerGid, tag) {
  if (!customerGid || !tag) return;
  try {
    const rows = await queryAsync(
      `SELECT COUNT(*) AS c FROM applications
        WHERE assigned_customer_gid = ? AND assigned_tag = ? AND id <> ?`,
      [customerGid, tag, id],
    );
    if (rows[0].c > 0) {
      log("info", "customer_untag_skipped", { id, customerGid, tag, others: rows[0].c });
      return;
    }
    await removeShopifyTag(customerGid, tag);
  } catch (e) {
    log("warn", "customer_untag_failed", { id, customerGid, tag, message: e.message });
  }
}

module.exports = { ORDER_TAGS, REFUND_TAG, addShopifyTag, listOrders, removeShopifyTag, sanitizeSearchTerm, untagCustomerIfUnused };
