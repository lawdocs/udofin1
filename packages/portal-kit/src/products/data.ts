import { ProductConfigCatalogue, ProductList } from '@udofin/contracts';
import { z } from 'zod';
import { type OnboardingApi } from '../onboarding/api.js';

const Categories = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      availability: z.string(),
      minTenureDays: z.number().int(),
    }),
  ),
});

export const loadProducts = (api: OnboardingApi, lenderId?: string) =>
  Promise.all([
    api.get(`/v1/lender/products${lenderId ? `?lenderId=${lenderId}` : ''}`, ProductList),
    api.get('/v1/lender/product-config-schema', ProductConfigCatalogue),
    api.get('/v1/lender/product-categories', Categories),
  ]);
