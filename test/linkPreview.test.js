const test = require('node:test')
const assert = require('node:assert/strict')
const { productHandleFromUrl, productToPreview } = require('../lib/chat')

const HOSTS = ['store.mediko.ph', 'mediko.ph']

test('productHandleFromUrl: store product links only', () => {
  assert.equal(productHandleFromUrl('https://store.mediko.ph/products/genacol-derma-aminolock-collagen-with-vit-c-vit-b-biotin-90-capsules', HOSTS),
    'genacol-derma-aminolock-collagen-with-vit-c-vit-b-biotin-90-capsules')
  assert.equal(productHandleFromUrl('https://store.mediko.ph/collections/all/products/vit-c?variant=1#x', HOSTS), 'vit-c')
  assert.equal(productHandleFromUrl('https://evil.example/products/vit-c', HOSTS), null)
  assert.equal(productHandleFromUrl('http://store.mediko.ph/products/vit-c', HOSTS), null)
  assert.equal(productHandleFromUrl('https://store.mediko.ph/pages/about', HOSTS), null)
  assert.equal(productHandleFromUrl('not a url', HOSTS), null)
  assert.equal(productHandleFromUrl('https://store.mediko.ph/products/../admin', HOSTS), null)
})

test('productToPreview maps the Admin API product', () => {
  const p = {
    title: 'Genacol Derma', description: 'Collagen with Vit C', status: 'ACTIVE',
    featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/s/files/1/g.jpg?v=1' } } },
    priceRangeV2: { minVariantPrice: { amount: '1899.0', currencyCode: 'PHP' } },
  }
  assert.deepEqual(productToPreview(p, 'https://store.mediko.ph/products/genacol'), {
    url: 'https://store.mediko.ph/products/genacol', title: 'Genacol Derma', description: 'Collagen with Vit C',
    image: 'https://cdn.shopify.com/s/files/1/g.jpg?v=1', price: '1899.00', currency: 'PHP',
  })
})

test('productToPreview: null for missing or unpublished products; trims long text', () => {
  assert.equal(productToPreview(null, 'u'), null)
  assert.equal(productToPreview({ title: 'X', status: 'DRAFT' }, 'u'), null)
  const out = productToPreview({ title: 'T'.repeat(250), description: 'd'.repeat(400), status: 'ACTIVE' }, 'https://store.mediko.ph/products/t')
  assert.equal(out.title.length, 200)
  assert.equal(out.description.length, 300)
  assert.equal(out.image, null)
  assert.equal(out.price, null)
})
