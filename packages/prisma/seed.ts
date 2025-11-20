import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

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
  const testRouterSecret = randomBytes(16).toString('hex');
  const router = await prisma.router.upsert({
    where: { token: 'test-router-token-123' },
    update: {},
    create: {
      name: 'Main Office Router',
      hostId: host.id,
      token: 'test-router-token-123',
      radiusSecret: testRouterSecret,
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
      shortName: `rtr-${router.id.substring(0, 8)}`,
      type: 'mikrotik',
      secret: testRouterSecret, // Use router's unique RADIUS secret
      description: 'Main Office Router (Auto-managed)',
    },
    {
      nasName: '0.0.0.0/0',
      shortName: 'any-client',
      type: 'other',
      secret: 'testing123',
      description: 'Allow all clients - TESTING ONLY (Remove in production)',
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
    const existingGroupCheck = await prisma.radGroupCheck.findFirst({
      where: {
        groupName: group.groupName,
        attribute: 'Simultaneous-Use'
      }
    });

    if (!existingGroupCheck) {
      await prisma.radGroupCheck.create({
        data: {
          groupName: group.groupName,
          attribute: 'Simultaneous-Use',
          op: ':=',
          value: '1',
        },
      });
    }

    // Create group reply
    const existingGroupReply = await prisma.radGroupReply.findFirst({
      where: {
        groupName: group.groupName,
        attribute: 'WISPr-Bandwidth-Max-Down'
      }
    });

    if (!existingGroupReply) {
      await prisma.radGroupReply.create({
        data: {
          groupName: group.groupName,
          attribute: 'WISPr-Bandwidth-Max-Down',
          op: ':=',
          value: group.maxBandwidth,
        },
      });
    }
  }

  // Assign testuser to basic group
  const existingUserGroup = await prisma.radUserGroup.findFirst({
    where: {
      userName: 'testuser',
      groupName: 'basic'
    }
  });

  if (!existingUserGroup) {
    await prisma.radUserGroup.create({
      data: {
        userName: 'testuser',
        groupName: 'basic',
        priority: 1,
      },
    });
  }

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

  // ============================================
  // 7. CREATE SERVICE PLANS
  // ============================================
  const plans = [
    {
      name: 'Basic 5GB',
      description: 'Basic plan with 5GB monthly data',
      price: 19.99,
      currency: 'USD',
      dataQuota: BigInt(5 * 1024 * 1024 * 1024), // 5GB
      quotaType: 'MONTHLY',
      maxUploadSpeed: BigInt(5 * 1024 * 1024), // 5 Mbps
      maxDownloadSpeed: BigInt(20 * 1024 * 1024), // 20 Mbps
      sessionTimeout: 7200, // 2 hours
      idleTimeout: 600, // 10 minutes
      maxSessions: 1,
      validityDays: 30,
      isDefault: true,
      status: 'ACTIVE',
    },
    {
      name: 'Premium 20GB',
      description: 'Premium plan with 20GB monthly data',
      price: 39.99,
      currency: 'USD',
      dataQuota: BigInt(20 * 1024 * 1024 * 1024), // 20GB
      quotaType: 'MONTHLY',
      maxUploadSpeed: BigInt(10 * 1024 * 1024), // 10 Mbps
      maxDownloadSpeed: BigInt(50 * 1024 * 1024), // 50 Mbps
      sessionTimeout: 14400, // 4 hours
      idleTimeout: 900, // 15 minutes
      maxSessions: 2,
      validityDays: 30,
      isDefault: false,
      status: 'ACTIVE',
    },
    {
      name: 'Unlimited',
      description: 'Unlimited data plan',
      price: 59.99,
      currency: 'USD',
      dataQuota: null, // Unlimited
      quotaType: 'MONTHLY',
      maxUploadSpeed: BigInt(20 * 1024 * 1024), // 20 Mbps
      maxDownloadSpeed: BigInt(100 * 1024 * 1024), // 100 Mbps
      sessionTimeout: null, // No limit
      idleTimeout: 1800, // 30 minutes
      maxSessions: 3,
      validityDays: 30,
      isDefault: false,
      status: 'ACTIVE',
    },
    {
      name: 'Daily 1GB',
      description: 'Daily plan with 1GB data (resets daily)',
      price: 4.99,
      currency: 'USD',
      dataQuota: BigInt(1 * 1024 * 1024 * 1024), // 1GB
      quotaType: 'DAILY',
      maxUploadSpeed: BigInt(2 * 1024 * 1024), // 2 Mbps
      maxDownloadSpeed: BigInt(10 * 1024 * 1024), // 10 Mbps
      sessionTimeout: 3600, // 1 hour
      idleTimeout: 300, // 5 minutes
      maxSessions: 1,
      validityDays: 7,
      isDefault: false,
      status: 'ACTIVE',
    },
  ];

  const createdPlans = [];
  for (const planData of plans) {
    const plan = await prisma.plan.upsert({
      where: { name: planData.name },
      update: {},
      create: {
        ...planData,
        createdById: admin.id,
      },
    });
    createdPlans.push(plan);
  }
  console.log('✅ Created service plans:', createdPlans.length);

  // ============================================
  // 8. CREATE END USERS
  // ============================================
  const endUsers = [
    {
      username: 'testuser',
      password: 'testpass',
      email: 'testuser@example.com',
      phone: '+1234567890',
      fullName: 'Test User',
      status: 'ACTIVE',
      notes: 'Test account for development',
    },
    {
      username: 'john.doe',
      password: 'password123',
      email: 'john.doe@example.com',
      phone: '+1234567891',
      fullName: 'John Doe',
      status: 'ACTIVE',
      notes: 'Premium customer',
    },
    {
      username: 'jane.smith',
      password: 'secure456',
      email: 'jane.smith@example.com',
      phone: '+1234567892',
      fullName: 'Jane Smith',
      status: 'ACTIVE',
      notes: 'Business customer',
    },
    {
      username: 'demo',
      password: 'demo123',
      email: 'demo@example.com',
      phone: null,
      fullName: 'Demo User',
      status: 'ACTIVE',
      notes: 'Demo account',
    },
    {
      username: 'trial.user',
      password: 'trial123',
      email: 'trial@example.com',
      phone: null,
      fullName: 'Trial User',
      status: 'ACTIVE',
      notes: 'Trial account with daily plan',
    },
  ];

  const createdEndUsers = [];
  for (const userData of endUsers) {
    // Hash password for app storage
    const hashedPassword = await bcrypt.hash(userData.password, 10);
    
    const existingEndUser = await prisma.endUser.findUnique({
      where: { username: userData.username },
    });

    let endUser;
    if (existingEndUser) {
      endUser = existingEndUser;
    } else {
      endUser = await prisma.endUser.create({
        data: {
          username: userData.username,
          password: hashedPassword,
          email: userData.email,
          phone: userData.phone,
          fullName: userData.fullName,
          status: userData.status,
          notes: userData.notes,
          createdById: admin.id,
        },
      });
    }
    createdEndUsers.push({ ...endUser, plainPassword: userData.password });

    // Create RADIUS entry (User-Password in radcheck)
    // Note: RADIUS needs plain text or hashed based on FreeRADIUS config
    // For testing, we'll use plain text (in production, use proper RADIUS hashing)
    const existingRadCheck = await prisma.radCheck.findFirst({
      where: {
        userName: userData.username,
        attribute: 'User-Password'
      }
    });

    if (existingRadCheck) {
      await prisma.radCheck.update({
        where: { id: existingRadCheck.id },
        data: { value: userData.password },
      });
    } else {
      await prisma.radCheck.create({
        data: {
          userName: userData.username,
          attribute: 'User-Password',
          op: ':=',
          value: userData.password,
        },
      });
    }
  }
  console.log('✅ Created end users:', createdEndUsers.length);

  // ============================================
  // 9. ASSIGN PLANS TO USERS
  // ============================================
  const planAssignments = [
    {
      username: 'testuser',
      planName: 'Basic 5GB',
      autoRenew: true,
    },
    {
      username: 'john.doe',
      planName: 'Premium 20GB',
      autoRenew: true,
    },
    {
      username: 'jane.smith',
      planName: 'Unlimited',
      autoRenew: true,
    },
    {
      username: 'demo',
      planName: 'Basic 5GB',
      autoRenew: false,
    },
    {
      username: 'trial.user',
      planName: 'Daily 1GB',
      autoRenew: false,
    },
  ];

  for (const assignment of planAssignments) {
    const endUser = createdEndUsers.find(u => u.username === assignment.username);
    const plan = createdPlans.find(p => p.name === assignment.planName);
    
    if (!endUser || !plan) continue;

    // Calculate expiry
    let expiresAt: Date | null = null;
    if (plan.validityDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + plan.validityDays);
    }

    // Check if user plan already exists
    const existingUserPlan = await prisma.userPlan.findFirst({
      where: {
        userId: endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
      },
    });

    if (existingUserPlan) {
      continue; // Skip if already assigned
    }

    // Create user plan
    await prisma.userPlan.create({
      data: {
        userId: endUser.id,
        planId: plan.id,
        status: 'ACTIVE',
        activatedAt: new Date(),
        expiresAt,
        dataQuota: plan.dataQuota,
        dataUsed: 0n,
        autoRenew: assignment.autoRenew,
        assignedById: admin.id,
      },
    });

    // Sync to RADIUS (radreply attributes)
    // Helper function to upsert radreply
    const upsertRadReply = async (username: string, attribute: string, value: string) => {
      const existing = await prisma.radReply.findFirst({
        where: {
          userName: username,
          attribute
        }
      });

      if (existing) {
        await prisma.radReply.update({
          where: { id: existing.id },
          data: { value },
        });
      } else {
        await prisma.radReply.create({
          data: {
            userName: username,
            attribute,
            op: '=',
            value,
          },
        });
      }
    };

    // Helper function to upsert radcheck
    const upsertRadCheck = async (username: string, attribute: string, value: string) => {
      const existing = await prisma.radCheck.findFirst({
        where: {
          userName: username,
          attribute
        }
      });

      if (existing) {
        await prisma.radCheck.update({
          where: { id: existing.id },
          data: { value },
        });
      } else {
        await prisma.radCheck.create({
          data: {
            userName: username,
            attribute,
            op: ':=',
            value,
          },
        });
      }
    };

    // Session-Timeout
    if (plan.sessionTimeout) {
      await upsertRadReply(assignment.username, 'Session-Timeout', plan.sessionTimeout.toString());
    }

    // Idle-Timeout
    if (plan.idleTimeout) {
      await upsertRadReply(assignment.username, 'Idle-Timeout', plan.idleTimeout.toString());
    }

    // Bandwidth limits
    if (plan.maxUploadSpeed) {
      await upsertRadReply(assignment.username, 'WISPr-Bandwidth-Max-Up', plan.maxUploadSpeed.toString());
    }

    if (plan.maxDownloadSpeed) {
      await upsertRadReply(assignment.username, 'WISPr-Bandwidth-Max-Down', plan.maxDownloadSpeed.toString());
    }

    // Data quota
    if (plan.dataQuota) {
      await upsertRadReply(assignment.username, 'MikroTik-Total-Limit', plan.dataQuota.toString());
    }

    // Max sessions
    if (plan.maxSessions) {
      await upsertRadCheck(assignment.username, 'Max-Daily-Session', plan.maxSessions.toString());
    }

    // Service-Type
    await upsertRadReply(assignment.username, 'Service-Type', 'Framed-User');
  }
  console.log('✅ Assigned plans to users:', planAssignments.length);

  // ============================================
  // 10. CREATE QUOTA TRACKING
  // ============================================
  const currentDate = new Date();
  const monthStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const monthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);

  for (const endUser of createdEndUsers) {
    const userPlan = await prisma.userPlan.findFirst({
      where: {
        userId: endUser.id,
        status: 'ACTIVE',
      },
      include: { plan: true },
    });

    if (userPlan && userPlan.plan.dataQuota) {
      // Check if quota entry exists
      const existingQuota = await prisma.radQuota.findFirst({
        where: {
          username: endUser.username,
          quotaType: userPlan.plan.quotaType.toLowerCase(),
          periodStart: monthStart,
        }
      });

      if (!existingQuota) {
        await prisma.radQuota.create({
          data: {
            username: endUser.username,
            quotaType: userPlan.plan.quotaType.toLowerCase(),
            maxOctets: userPlan.plan.dataQuota,
            usedOctets: 0n,
            periodStart: monthStart,
            periodEnd: monthEnd,
          },
        });
      }
    }
  }
  console.log('✅ Created quota tracking entries');

  console.log('✨ Seeding completed successfully!');
  console.log('');
  console.log('📝 Test Credentials:');
  console.log('   App Admin: admin@spotfi.com / admin123');
  console.log('   App Host:  host@spotfi.com / host123');
  console.log('');
  console.log('📱 End Users (WiFi):');
  for (const user of createdEndUsers) {
    const userPlan = await prisma.userPlan.findFirst({
      where: {
        userId: user.id,
        status: 'ACTIVE',
      },
      include: { plan: true },
    });
    const planName = userPlan?.plan.name || 'No plan';
    console.log(`   ${user.username} / ${user.plainPassword} (Plan: ${planName})`);
  }
  console.log('');
  console.log('📦 Service Plans:');
  for (const plan of createdPlans) {
    const quota = plan.dataQuota ? `${Number(plan.dataQuota) / (1024 * 1024 * 1024)}GB` : 'Unlimited';
    console.log(`   ${plan.name}: $${plan.price}/${plan.quotaType.toLowerCase()} - ${quota}`);
  }
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

