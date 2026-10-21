import { createContext } from 'react';

// Pages can replace unavailable content once both remote image sources fail.
export const ImageFailureContext = createContext<((src: string) => void) | undefined>(undefined);
