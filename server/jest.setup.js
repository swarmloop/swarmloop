// A spec must not depend on the free space of the machine it runs on. Specs of the disk guard set their own limit.
process.env.MIN_FREE_GB = '0';
