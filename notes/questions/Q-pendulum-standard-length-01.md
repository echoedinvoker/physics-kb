---
id: 202602251636
title: "Q-pendulum-standard-length-01"
created: 2026-02-25
tags:
  - type/question
  - topic/pendulum
  - chapter/1-3
  - difficulty/advanced
  - question-type/calculation
  - source/108-textbook
  - status/draft
chapter: "1-3"
topic_path: "物理學/物理與測量/單擺"
related_chapters: []
context_header: "考察從快慢擺反推標準擺長。"
tests_concepts: ["[[單擺]]"]
answer: "4l₁l₂/(√l₁+√l₂)²"
---

# Q-pendulum-standard-length-01

## 題目

在相同時間內以長l₁的單擺計時較標準擺快t秒，而長改為l₂時較標準擺慢t秒，則標準擺之擺長為何？

## 答案

4l₁l₂/(√l₁+√l₂)²

## 解析

設標準擺長L，週期T₀=2π√(L/g)
長l₁的擺較快→T₁<T₀→l₁<L
長l₂的擺較慢→T₂>T₀→l₂>L

相同時間Δt內：n₁T₁=n₀T₀=n₂T₂
快t秒：n₁-n₀=t/T₀（多擺了t/T₀次）→但更精確地...

設在真實時間τ內，標準擺走n₀=τ/T₀次，l₁擺走n₁=τ/T₁次
快t秒→n₁T₀-τ=t→τ(T₀/T₁-1)=t
慢t秒→τ-n₂T₀=t→τ(1-T₀/T₂)=t

所以T₀/T₁-1=1-T₀/T₂→T₀/T₁+T₀/T₂=2
→1/√l₁+1/√l₂=2/√L（因T∝√L）
→√L=2√(l₁)√(l₂)/(√l₁+√l₂)
→L=4l₁l₂/(√l₁+√l₂)²

## 測試概念

- [[單擺]] — 單擺週期與擺長的關係，反推標準擺長
