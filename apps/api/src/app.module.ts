import { Module } from '@nestjs/common';
import { DbModule } from './db';
import { AuthModule } from './auth';
import { AuthzModule } from './authz';
import { StorageModule } from './storage';
import { DocumentsModule } from './documents';
import { ReportsModule } from './reports';
import { HrModule } from './hr';
import { LeaveModule } from './leave';
import { WorkModule } from './work';
import { SettingsModule } from './settings';
import { PayrollModule } from './payroll';
import { OrgModule } from './org';
import { PeopleModule } from './people';
import { WorkMastersModule } from './work-masters';
import { AccountsModule } from './accounts';
import { OnboardingModule } from './onboarding';

@Module({
  imports: [
    DbModule, AuthModule, AuthzModule, StorageModule,
    DocumentsModule, ReportsModule, HrModule, LeaveModule, WorkModule, SettingsModule,
    PayrollModule, OrgModule, PeopleModule, WorkMastersModule, AccountsModule, OnboardingModule,
  ],
})
export class AppModule {}
