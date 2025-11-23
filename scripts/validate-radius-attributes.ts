#!/usr/bin/env tsx
/**
 * Validates RADIUS attributes before deployment
 * Run: npm run validate:radius
 * 
 * This script checks for invalid RADIUS attributes in the database
 * and ensures all attributes are valid FreeRADIUS attributes.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Valid FreeRADIUS attributes (standard RFC attributes)
const VALID_RADCHECK_ATTRIBUTES = [
  'User-Password',
  'Cleartext-Password',
  'NT-Password',
  'LM-Password',
  'MD5-Password',
  'SHA-Password',
  'Crypt-Password',
  'SSHA-Password',
  'SMD5-Password',
  'SHA1-Password',
  'SHA2-Password',
  'Auth-Type',
  'Simultaneous-Use',
  'Expiration',
  'Fall-Through',
  'Reply-Message',
  'Auth-Data-Type',
  'Password-With-Header',
];

const VALID_RADREPLY_ATTRIBUTES = [
  'Session-Timeout',
  'Idle-Timeout',
  'WISPr-Bandwidth-Max-Down',
  'WISPr-Bandwidth-Max-Up',
  'ChilliSpot-Max-Total-Octets',
  'ChilliSpot-Max-Input-Octets',
  'ChilliSpot-Max-Output-Octets',
  'Service-Type',
  'Framed-Protocol',
  'Framed-IP-Address',
  'Framed-IP-Netmask',
  'Framed-Route',
  'Framed-IPv6-Prefix',
  'Framed-IPv6-Pool',
  'Framed-IPv6-Route',
  'Class',
  'Reply-Message',
  'MikroTik-Total-Limit', // Vendor-specific but commonly used
];

// Known invalid attributes that should never be used
const INVALID_ATTRIBUTES = [
  'Max-Daily-Session', // Should use Simultaneous-Use instead
];

async function validateRadiusAttributes() {
  console.log('🔍 Validating RADIUS attributes...\n');

  let hasErrors = false;
  const errors: string[] = [];

  // Check radcheck table
  const radcheckEntries = await prisma.radCheck.findMany({
    select: { attribute: true },
    distinct: ['attribute'],
  });

  console.log('📋 Checking radcheck attributes...');
  const radcheckAttributes = new Set<string>();
  for (const entry of radcheckEntries) {
    radcheckAttributes.add(entry.attribute);
    
    if (INVALID_ATTRIBUTES.includes(entry.attribute)) {
      const error = `❌ Invalid radcheck attribute: "${entry.attribute}" (known invalid attribute)`;
      console.error(error);
      errors.push(error);
      hasErrors = true;
    } else if (!VALID_RADCHECK_ATTRIBUTES.includes(entry.attribute)) {
      const error = `⚠️  Unknown radcheck attribute: "${entry.attribute}" (not in standard list)`;
      console.warn(error);
      errors.push(error);
      hasErrors = true;
    } else {
      console.log(`✅ Valid: ${entry.attribute}`);
    }
  }

  // Check radreply table
  const radreplyEntries = await prisma.radReply.findMany({
    select: { attribute: true },
    distinct: ['attribute'],
  });

  console.log('\n📋 Checking radreply attributes...');
  const radreplyAttributes = new Set<string>();
  for (const entry of radreplyEntries) {
    radreplyAttributes.add(entry.attribute);
    
    if (INVALID_ATTRIBUTES.includes(entry.attribute)) {
      const error = `❌ Invalid radreply attribute: "${entry.attribute}" (known invalid attribute)`;
      console.error(error);
      errors.push(error);
      hasErrors = true;
    } else if (!VALID_RADREPLY_ATTRIBUTES.includes(entry.attribute)) {
      const error = `⚠️  Unknown radreply attribute: "${entry.attribute}" (not in standard list)`;
      console.warn(error);
      errors.push(error);
      hasErrors = true;
    } else {
      console.log(`✅ Valid: ${entry.attribute}`);
    }
  }

  // Check for known invalid attributes in database
  const invalidRadCheck = await prisma.radCheck.findMany({
    where: {
      attribute: { in: INVALID_ATTRIBUTES },
    },
    select: {
      userName: true,
      attribute: true,
      id: true,
    },
  });

  if (invalidRadCheck.length > 0) {
    console.error(`\n❌ Found ${invalidRadCheck.length} radcheck entries with invalid attributes:`);
    for (const entry of invalidRadCheck) {
      const error = `   - User: ${entry.userName}, Attribute: ${entry.attribute} (ID: ${entry.id})`;
      console.error(error);
      errors.push(error);
    }
    hasErrors = true;
  }

  const invalidRadReply = await prisma.radReply.findMany({
    where: {
      attribute: { in: INVALID_ATTRIBUTES },
    },
    select: {
      userName: true,
      attribute: true,
      id: true,
    },
  });

  if (invalidRadReply.length > 0) {
    console.error(`\n❌ Found ${invalidRadReply.length} radreply entries with invalid attributes:`);
    for (const entry of invalidRadReply) {
      const error = `   - User: ${entry.userName}, Attribute: ${entry.attribute} (ID: ${entry.id})`;
      console.error(error);
      errors.push(error);
    }
    hasErrors = true;
  }

  // Summary
  console.log('\n📊 Summary:');
  console.log(`   radcheck attributes found: ${radcheckAttributes.size}`);
  console.log(`   radreply attributes found: ${radreplyAttributes.size}`);
  console.log(`   Invalid entries: ${invalidRadCheck.length + invalidRadReply.length}`);

  if (hasErrors) {
    console.error('\n❌ Validation failed! Fix invalid attributes before deployment.');
    console.error('\n💡 To fix invalid attributes:');
    console.error('   1. Update code to use valid attributes (e.g., Simultaneous-Use instead of Max-Daily-Session)');
    console.error('   2. Clean up database: DELETE FROM radcheck WHERE attribute IN (\'Max-Daily-Session\');');
    console.error('   3. Re-run validation: npm run validate:radius');
    process.exit(1);
  } else {
    console.log('\n✅ All RADIUS attributes are valid!');
    console.log('   Ready for deployment.');
  }
}

validateRadiusAttributes()
  .catch((e) => {
    console.error('❌ Validation error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

