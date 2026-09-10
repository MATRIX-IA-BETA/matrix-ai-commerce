# SIC migration preflight

The SICNET backup contains historical references that no longer exist in current master tables.

Observed in the validated backup:

- Missing sales channel master IDs still referenced by sales: 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14.
- 94 historical payment rows reference sales that no longer exist in the SIC sales table.
- Sale type references are complete.
- Payment method references are complete.
- Sale item -> sale references are complete.
- Purchase item -> purchase references are complete.
- Quote item -> quote references are complete.

Policy:

- Preserve missing channel IDs as `Canal legado SIC #<id>` instead of inventing a historical name.
- Preserve orphan payment rows in `erp_sale_payments`; the legacy sale control remains queryable but is intentionally not protected by a foreign key.
- Never create synthetic sales just to satisfy a historical foreign key.
- Historical import does not create stock-out movements. Only the SIC opening balance affects stock during migration.
