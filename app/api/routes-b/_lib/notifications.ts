import { prisma } from '@/lib/db';
import { startOfDay, endOfDay, subDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

export type DigestResponse = {
  period: string;                    // e.g. "2026-04-29"
  totalsByType: Record<string, number>;
  top: Array<{
    type: string;
    count: number;
  }>;
};

/**
 * Get daily digest for a user respecting their timezone
 */
export async function getDailyDigest(
  userId: string,
  dateStr: string | null,
  userTimezone: string = 'Africa/Lagos'   // fallback to Lagos (your location)
): Promise<DigestResponse> {
  const tz = userTimezone;

  let targetDate: Date;
  if (dateStr) {
    // Parse YYYY-MM-DD in user's timezone
    const [year, month, day] = dateStr.split('-').map(Number);
    targetDate = new Date(year, month - 1, day);
  } else {
    // Default to today in user's timezone
    targetDate = new Date();
  }

  // Convert to user's timezone and get start/end of day in UTC
  const zonedDate = toZonedTime(targetDate, tz);
  const start = startOfDay(zonedDate);
  const end = endOfDay(zonedDate);

  // Reject future dates
  if (start > new Date()) {
    throw new Error('FUTURE_DATE_NOT_ALLOWED');
  }

  const notifications = await prisma.notification.groupBy({
    by: ['type'],
    where: {
      userId,
      createdAt: {
        gte: start,
        lte: end,
      },
    },
    _count: {
      id: true,
    },
    orderBy: {
      _count: {
        id: 'desc',
      },
    },
  });

  const totalsByType: Record<string, number> = {};
  const top: Array<{ type: string; count: number }> = [];

  notifications.forEach((group) => {
    const count = group._count.id;
    totalsByType[group.type] = count;
    top.push({ type: group.type, count });
  });

  const period = dateStr || targetDate.toISOString().split('T')[0];

  return {
    period,
    totalsByType,
    top,
  };
}