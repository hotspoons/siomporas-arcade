// Every playable course, in menu order (escalating difficulty), then the M1 proving run.

import type { CourseDesc } from '../SegmentDesc'
import { COURSE_01 } from './course01'
import { COURSE_02 } from './course02'
import { COURSE_03 } from './course03'
import { COURSE_04 } from './course04'
import { TEST_COURSE } from './testCourse'

export const COURSES: CourseDesc[] = [COURSE_01, COURSE_02, COURSE_04, COURSE_03, TEST_COURSE]
