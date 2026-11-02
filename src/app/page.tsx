"use client";

import Image from "next/image";
import voteImg from "@/app/images/vote.png";
// import styles from "./page.module.css";
import { Center, Link, VStack } from "@chakra-ui/react";
import Subject from "./components/Subject";
import Choices from "./components/Choices";
import Email from "./components/Email";
import { proverInstallGuideUrl } from "./constants";

export default function Home() {
  return (
    <>
      <VStack>
        <Image
          src={voteImg}
          alt="Voty logo"
          width={150}
        />
        <Center fontSize="3xl" fontWeight="800" textAlign={"center"}>
          Secured vote using Starknet ZK technology
        </Center>
      </VStack>

      <VStack>
        <Email></Email>
        <Subject></Subject>
        <Choices></Choices>
      </VStack>

      <Center fontSize="sm" mt={6} textAlign="center">
        <span>
          The proofs come from a SNIP-36 proof server. Install your own:{" "}
          <Link href={proverInstallGuideUrl} target="_blank" rel="noreferrer" textDecoration="underline">installation guide</Link>
        </span>
      </Center>
    </>
  );
}
