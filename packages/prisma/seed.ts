import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ============================================
  // 1. CREATE APP USERS
  // ============================================
  const adminPassword = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@spotfi.com' },
    update: {},
    create: {
      email: 'admin@spotfi.com',
      password: adminPassword,
      role: 'ADMIN',
    },
  });
  console.log('✅ Created admin user:', admin.email);

  const hostPassword = await bcrypt.hash('host123', 10);
  const host = await prisma.user.upsert({
    where: { email: 'host@spotfi.com' },
    update: {},
    create: {
      email: 'host@spotfi.com',
      password: hostPassword,
      role: 'HOST',
    },
  });
  console.log('✅ Created host user:', host.email);

  // ============================================
  // 2. CREATE SAMPLE ROUTER
  // ============================================
  const router = await prisma.router.upsert({
    where: { token: 'test-router-token-123' },
    update: {},
    create: {
      name: 'Main Office Router',
      hostId: host.id,
      token: 'test-router-token-123',
      status: 'ONLINE',
      nasipaddress: '192.168.1.1',
      macAddress: '00:11:22:33:44:55',
      location: 'Main Office - Floor 1',
      lastSeen: new Date(),
    },
  });
  console.log('✅ Created sample router:', router.name);

  // ============================================
  // 3. CREATE NAS CLIENTS (Network Access Servers)
  // ============================================
  const nasClients = [
    {
      nasName: '127.0.1.1',
      shortName: 'localhost-test',
      type: 'other',
      secret: 'testing123',
      description: 'Local test client',
    },
    {
      nasName: '192.168.1.1',
      shortName: 'main-router',
      type: 'mikrotik',
      secret: 'testing123',
      description: 'Main Office Router',
    },
    {
      nasName: '0.0.0.0/0',
      shortName: 'any-client',
      type: 'other',
      secret: 'testing123',
      description: 'Allow all clients - TESTING ONLY',
    },
  ];

  for (const nas of nasClients) {
    await prisma.nas.upsert({
      where: { nasName: nas.nasName },
      update: {},
      create: nas,
    });
  }
  console.log('✅ Created NAS clients:', nasClients.length);

  // ============================================
  // 4. CREATE RADIUS TEST USERS
  // ============================================
  const radiusUsers = [
    {
      userName: 'testuser',
      password: 'testpass',
      sessionTimeout: '3600', // 1 hour
    },
    {
      userName: 'john.doe',
      password: 'password123',
      sessionTimeout: '7200', // 2 hours
    },
    {
      userName: 'jane.smith',
      password: 'secure456',
      sessionTimeout: '14400', // 4 hours
    },
    {
      userName: 'demo',
      password: 'demo123',
      sessionTimeout: '1800', // 30 minutes
    },
  ];

  for (const user of radiusUsers) {
    // Create user credential (radcheck)
    await prisma.radCheck.upsert({
      where: { 
        userName_attribute: {
          userName: user.userName,
          attribute: 'Cleartext-Password'
        }
      },
      update: { value: user.password },
      create: {
        userName: user.userName,
        attribute: 'Cleartext-Password',
        op: ':=',
        value: user.password,
      },
    });

    // Create user reply attributes (radreply)
    await prisma.radReply.upsert({
      where: {
        userName_attribute: {
          userName: user.userName,
          attribute: 'Session-Timeout'
        }
      },
      update: { value: user.sessionTimeout },
      create: {
        userName: user.userName,
        attribute: 'Session-Timeout',
        op: ':=',
        value: user.sessionTimeout,
      },
    });

    // Add Service-Type reply
    await prisma.radReply.upsert({
      where: {
        userName_attribute: {
          userName: user.userName,
          attribute: 'Service-Type'
        }
      },
      update: {},
      create: {
        userName: user.userName,
        attribute: 'Service-Type',
        op: ':=',
        value: 'Framed-User',
      },
    });
  }
  console.log('✅ Created RADIUS users:', radiusUsers.length);

  // ============================================
  // 5. CREATE SAMPLE USER GROUPS
  // ============================================
  const groups = [
    {
      groupName: 'basic',
      maxBandwidth: '5000000', // 5 Mbps in bits per second
    },
    {
      groupName: 'premium',
      maxBandwidth: '20000000', // 20 Mbps in bits per second
    },
  ];

  for (const group of groups) {
    // Create group check
    await prisma.radGroupCheck.upsert({
      where: {
        groupName_attribute: {
          groupName: group.groupName,
          attribute: 'Simultaneous-Use'
        }
      },
      update: {},
      create: {
        groupName: group.groupName,
        attribute: 'Simultaneous-Use',
        op: ':=',
        value: '1',
      },
    });

    // Create group reply
    await prisma.radGroupReply.upsert({
      where: {
        groupName_attribute: {
          groupName: group.groupName,
          attribute: 'WISPr-Bandwidth-Max-Down'
        }
      },
      update: {},
      create: {
        groupName: group.groupName,
        attribute: 'WISPr-Bandwidth-Max-Down',
        op: ':=',
        value: group.maxBandwidth,
      },
    });
  }

  // Assign testuser to basic group
  await prisma.radUserGroup.upsert({
    where: {
      userName_groupName: {
        userName: 'testuser',
        groupName: 'basic'
      }
    },
    update: {},
    create: {
      userName: 'testuser',
      groupName: 'basic',
      priority: 1,
    },
  });

  console.log('✅ Created user groups:', groups.length);

  // ============================================
  // 6. CREATE SAMPLE ACCOUNTING SESSIONS
  // ============================================
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  const sessions = [
    {
      acctUniqueId: `test-session-${Date.now()}-1`,
      acctSessionId: 'session-001',
      userName: 'testuser',
      nasIpAddress: '192.168.1.1',
      callingStationId: 'AA:BB:CC:DD:EE:FF',
      acctStartTime: twoHoursAgo,
      acctStopTime: oneHourAgo,
      acctSessionTime: BigInt(3600), // 1 hour in seconds
      acctInputOctets: BigInt(104857600), // 100 MB
      acctOutputOctets: BigInt(524288000), // 500 MB
      framedIpAddress: '10.0.0.100',
    },
    {
      acctUniqueId: `test-session-${Date.now()}-2`,
      acctSessionId: 'session-002',
      userName: 'john.doe',
      nasIpAddress: '192.168.1.1',
      callingStationId: '11:22:33:44:55:66',
      acctStartTime: oneHourAgo,
      acctStopTime: null, // Active session
      acctSessionTime: null,
      acctInputOctets: BigInt(52428800), // 50 MB
      acctOutputOctets: BigInt(157286400), // 150 MB
      framedIpAddress: '10.0.0.101',
    },
  ];

  for (const session of sessions) {
    await prisma.radAcct.create({
      data: {
        acctUniqueId: session.acctUniqueId,
        acctSessionId: session.acctSessionId,
        userName: session.userName,
        nasIpAddress: session.nasIpAddress,
        callingStationId: session.callingStationId,
        acctStartTime: session.acctStartTime,
        acctStopTime: session.acctStopTime,
        acctSessionTime: session.acctSessionTime,
        acctInputOctets: session.acctInputOctets,
        acctOutputOctets: session.acctOutputOctets,
        framedIpAddress: session.framedIpAddress,
        nasPortId: '1',
        nasPortType: 'Wireless-802.11',
        serviceType: 'Framed-User',
        framedProtocol: 'PPP',
        routerId: router.id,
      },
    });
  }
  console.log('✅ Created sample sessions:', sessions.length);

  console.log('✨ Seeding completed successfully!');
  console.log('');
  console.log('📝 Test Credentials:');
  console.log('   App Admin: admin@spotfi.com / admin123');
  console.log('   App Host:  host@spotfi.com / host123');
  console.log('   RADIUS:    testuser / testpass');
  console.log('   RADIUS:    john.doe / password123');
  console.log('   RADIUS:    jane.smith / secure456');
  console.log('   RADIUS:    demo / demo123');
  console.log('');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

