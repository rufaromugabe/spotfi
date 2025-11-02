import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['ADMIN', 'HOST']).default('HOST'),
});

// MAC address validation regex (accepts various formats)
const macAddressRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$|^[0-9A-Fa-f]{12}$/;

export const RouterCreateSchema = z.object({
  name: z.string().min(1),
  hostId: z.string().min(1), // Required: router must have a host
  macAddress: z.string().regex(macAddressRegex, 'Invalid MAC address format. Use AA:BB:CC:DD:EE:FF, AA-BB-CC-DD-EE-FF, or AABBCCDDEEFF'), // Required: MAC address for robust tracking
  location: z.string().optional(),
  // nasipaddress removed - IP is automatically detected when router connects via WebSocket
});

export const RouterCommandSchema = z.object({
  command: z.enum(['reboot', 'fetch-logs', 'get-status', 'update-config']),
  params: z.record(z.unknown()).optional(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type RouterCreateInput = z.infer<typeof RouterCreateSchema>;
export type RouterCommandInput = z.infer<typeof RouterCommandSchema>;

