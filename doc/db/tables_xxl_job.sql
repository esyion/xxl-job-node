--
-- xxl-job-node database schema (compatible with xxl-job 3.5.x tables)
--

CREATE DATABASE IF NOT EXISTS `xxl_job` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `xxl_job`;

-- ================== job group and registry ==================

CREATE TABLE `xxl_job_group`
(
    `id`            INT         NOT NULL AUTO_INCREMENT,
    `app_name`      VARCHAR(64) NOT NULL COMMENT '执行器AppName',
    `name`          VARCHAR(64) NOT NULL COMMENT '执行器名称',
    `address_type`  TINYINT     NOT NULL DEFAULT 0 COMMENT '执行器地址类型：0=自动注册、1=手动录入',
    `address_list`  TEXT        DEFAULT NULL COMMENT '执行器地址列表，多地址逗号分隔',
    `access_token`  VARCHAR(255) DEFAULT NULL COMMENT '执行器AccessToken',
    `update_time`   DATETIME    DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `i_app_name` (`app_name`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE `xxl_job_registry`
(
    `id`             BIGINT       NOT NULL AUTO_INCREMENT,
    `registry_group` VARCHAR(50)  NOT NULL,
    `registry_key`   VARCHAR(255) NOT NULL,
    `registry_value` VARCHAR(255) NOT NULL,
    `update_time`    DATETIME     DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `i_g_k_v` (`registry_group`, `registry_key`, `registry_value`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ================== job info ==================

CREATE TABLE `xxl_job_info`
(
    `id`                        INT          NOT NULL AUTO_INCREMENT,
    `job_group`                 INT          NOT NULL COMMENT '执行器主键ID',
    `name`                      VARCHAR(255) NOT NULL COMMENT '任务名称',
    `author`                    VARCHAR(64)  DEFAULT NULL COMMENT '作者',
    `alarm_email`               VARCHAR(255) DEFAULT NULL COMMENT '报警邮件',
    `schedule_type`             VARCHAR(50)  NOT NULL DEFAULT 'NONE' COMMENT '调度类型：NONE/CRON/FIX_RATE',
    `schedule_conf`             VARCHAR(128) DEFAULT NULL COMMENT '调度配置：cron 或 秒数',
    `misfire_strategy`          VARCHAR(50)  NOT NULL DEFAULT 'DO_NOTHING' COMMENT '过期策略',
    `executor_route_strategy`   VARCHAR(50)  DEFAULT NULL COMMENT '路由策略',
    `executor_handler`          VARCHAR(255) DEFAULT NULL COMMENT '任务handler',
    `executor_param`            TEXT         DEFAULT NULL COMMENT '任务参数',
    `executor_block_strategy`   VARCHAR(50)  DEFAULT NULL COMMENT '阻塞策略',
    `executor_timeout`          INT          NOT NULL DEFAULT 0 COMMENT '超时（秒）',
    `executor_fail_retry_count` INT          NOT NULL DEFAULT 0 COMMENT '失败重试次数',
    `glue_type`                 VARCHAR(50)  NOT NULL DEFAULT 'BEAN' COMMENT 'GLUE类型',
    `glue_source`               MEDIUMTEXT   DEFAULT NULL COMMENT 'GLUE源码',
    `glue_remark`               VARCHAR(128) DEFAULT NULL COMMENT 'GLUE备注',
    `glue_updatetime`           DATETIME     DEFAULT NULL COMMENT 'GLUE更新时间',
    `child_jobid`               VARCHAR(255) DEFAULT NULL COMMENT '子任务ID，逗号分隔',
    `trigger_status`            TINYINT      NOT NULL DEFAULT 0 COMMENT '0=停止 1=运行',
    `trigger_last_time`         BIGINT       NOT NULL DEFAULT 0 COMMENT '上次调度时间(ms)',
    `trigger_next_time`         BIGINT       NOT NULL DEFAULT 0 COMMENT '下次调度时间(ms)',
    `add_time`                  DATETIME     DEFAULT NULL,
    `update_time`               DATETIME     DEFAULT NULL,
    PRIMARY KEY (`id`),
    KEY `i_trigger_next_time` (`trigger_status`, `trigger_next_time`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE `xxl_job_logglue`
(
    `id`          INT          NOT NULL AUTO_INCREMENT,
    `job_id`      INT          NOT NULL,
    `glue_type`   VARCHAR(50)  DEFAULT NULL,
    `glue_source` MEDIUMTEXT   DEFAULT NULL,
    `glue_remark` VARCHAR(128) NOT NULL,
    `add_time`    DATETIME     DEFAULT NULL,
    `update_time` DATETIME     DEFAULT NULL,
    PRIMARY KEY (`id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ================== job log and report ==================

CREATE TABLE `xxl_job_log`
(
    `id`                        BIGINT       NOT NULL AUTO_INCREMENT,
    `job_group`                 INT          NOT NULL,
    `job_id`                    INT          NOT NULL,
    `executor_address`          VARCHAR(255) DEFAULT NULL COMMENT '执行地址',
    `executor_handler`          VARCHAR(255) DEFAULT NULL,
    `executor_param`            TEXT         DEFAULT NULL,
    `executor_sharding_param`   VARCHAR(20)  DEFAULT NULL COMMENT '分片参数 idx/total',
    `executor_fail_retry_count` INT          NOT NULL DEFAULT 0,
    `trigger_time`              DATETIME     DEFAULT NULL COMMENT '调度时间',
    `trigger_code`              INT          NOT NULL COMMENT '调度结果',
    `trigger_msg`               TEXT         DEFAULT NULL COMMENT '调度日志',
    `handle_time`               DATETIME     DEFAULT NULL COMMENT '执行时间',
    `handle_code`               INT          NOT NULL COMMENT '执行状态',
    `handle_msg`                TEXT         DEFAULT NULL COMMENT '执行日志',
    `alarm_status`              TINYINT      NOT NULL DEFAULT 0 COMMENT '0默认 -1锁定 1无需 2成功 3失败',
    PRIMARY KEY (`id`),
    KEY `i_trigger_time` (`trigger_time`),
    KEY `i_handle_code` (`handle_code`),
    KEY `i_job_group` (`job_group`),
    KEY `i_job_id` (`job_id`),
    KEY `i_alarm_status` (`alarm_status`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE `xxl_job_log_report`
(
    `id`            INT      NOT NULL AUTO_INCREMENT,
    `trigger_day`   DATETIME DEFAULT NULL,
    `running_count` INT      NOT NULL DEFAULT 0,
    `suc_count`     INT      NOT NULL DEFAULT 0,
    `fail_count`    INT      NOT NULL DEFAULT 0,
    `update_time`   DATETIME DEFAULT NULL,
    PRIMARY KEY (`id`),
    UNIQUE KEY `i_trigger_day` (`trigger_day`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ================== lock ==================

CREATE TABLE `xxl_job_lock`
(
    `lock_name` VARCHAR(50) NOT NULL,
    PRIMARY KEY (`lock_name`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ================== user ==================

CREATE TABLE `xxl_job_user`
(
    `id`         INT          NOT NULL AUTO_INCREMENT,
    `username`   VARCHAR(50)  NOT NULL,
    `password`   VARCHAR(100) NOT NULL COMMENT 'sha256 hex',
    `token`      VARCHAR(100) DEFAULT NULL,
    `role`       TINYINT      NOT NULL COMMENT '0=普通 1=管理员',
    `permission` VARCHAR(255) DEFAULT NULL COMMENT '执行器组ID列表',
    PRIMARY KEY (`id`),
    UNIQUE KEY `i_username` (`username`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ================== default data ==================

START TRANSACTION;

INSERT INTO `xxl_job_group`(`id`, `app_name`, `name`, `address_type`, `address_list`, `access_token`, `update_time`)
VALUES (1, 'xxl-job-node-sample', 'Node示例执行器', 0, NULL, 'default_token', now());

INSERT INTO `xxl_job_info`(`id`, `job_group`, `name`, `add_time`, `update_time`, `author`, `alarm_email`,
                           `schedule_type`, `schedule_conf`, `misfire_strategy`, `executor_route_strategy`,
                           `executor_handler`, `executor_param`, `executor_block_strategy`, `executor_timeout`,
                           `executor_fail_retry_count`, `glue_type`, `glue_source`, `glue_remark`, `glue_updatetime`,
                           `child_jobid`)
VALUES (1, 1, '示例任务：每分钟输出参数', now(), now(), 'XXL', '', 'CRON', '0 * * * * ? *',
        'DO_NOTHING', 'FIRST', 'demoJobHandler', 'hello xxl-job-node', 'SERIAL_EXECUTION', 0, 0, 'BEAN', '',
        'GLUE代码初始化', now(), '');

-- sha256('123456')
INSERT INTO `xxl_job_user`(`id`, `username`, `password`, `role`, `permission`)
VALUES (1, 'admin', '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92', 1, NULL);

INSERT INTO `xxl_job_lock` (`lock_name`)
VALUES ('schedule_lock');

COMMIT;
