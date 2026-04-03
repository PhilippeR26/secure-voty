"use server";

import Image from "next/image";
import voteImg from "@/app/images/vote.png";
// import styles from "./page.module.css";
import { Center, VStack } from "@chakra-ui/react";
import Subject from "./components/Subject";
import Choices from "./components/Choices";
import Email from "./components/Email";

export default async function Home() {
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
    </>
  );
}
