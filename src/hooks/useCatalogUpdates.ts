import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { watchCatalogUpdates } from '@/lib/catalogUpdates';

export function CatalogUpdates() {
  const client = useQueryClient();
  useEffect(() => watchCatalogUpdates(client), [client]);
  return null;
}
