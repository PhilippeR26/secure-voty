"use client";

import { useForm } from "react-hook-form";
import { useStoreChoice } from "./contextChoice";
import { Button, Center, Field, Input, Text } from "@chakra-ui/react";
import { useState } from "react";
import { authenticate } from "../server/authenticate";

interface FormValues {
  emailValue: string,
  secretValue: string,
}
export default function Email() {
  const [isWhiteListed, setIsWhiteListed] = useState<boolean | null>(null);
  const [secretValid, setSecretValid] = useState<boolean | null>(null);
  const { email, setEmail, userAuthorized, setUserAuthorized } = useStoreChoice();

  const {
    handleSubmit,
    register,
    formState: { errors, isSubmitting, isValid }
  } = useForm<FormValues>();

  async function onSubmitResponse(values: FormValues) {
    setIsWhiteListed(null);
    setSecretValid(null);
    setUserAuthorized(false);

    const result = await authenticate(values.emailValue, values.secretValue);

    setIsWhiteListed(result.isWhiteListed);
    setSecretValid(result.secretValid);
    if (result.isWhiteListed && result.secretValid) {
      setEmail(values.emailValue);
      setUserAuthorized(true);
    }
  }


  return (
    <>
      {!userAuthorized ? (
        <>
          <Center>
            <form onSubmit={handleSubmit(onSubmitResponse)}>
              <Field.Root invalid={!!errors.emailValue}>
                <Field.Label htmlFor="emailInput"> Your email to vote :</Field.Label>
                <Input
                  w="100%" minH={50} maxH={500}
                  bg="gray.800"
                  color="blue.200"
                  defaultValue={email}
                  id="emailInput"
                  {...register("emailValue", {
                    required: "This is required. Ex: nom@site.com", pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
                  })}
                />
                <Field.ErrorText color={"darkred"}>
                  {errors.emailValue && errors.emailValue.message}
                  {errors.emailValue && errors.emailValue.type == "pattern" && <span>Not a valid email address</span>}
                </Field.ErrorText>
              </Field.Root>
              <Field.Root invalid={!!errors.secretValue} mt={3}>
                <Field.Label htmlFor="secretInput"> The 8 digit secret you received by email :</Field.Label>
                <Input
                  w="100%" minH={50} maxH={500}
                  bg="gray.800"
                  color="blue.200"
                  id="secretInput"
                  {...register("secretValue", {
                    required: "This is required. Ex: 12345678",
                    pattern: {
                      value: /^\d{8}$/,
                      message: "Must be exactly 8 digits"
                    }
                  })}
                />
                <Field.ErrorText color={"darkred"}>
                  {errors.secretValue && errors.secretValue.message}
                </Field.ErrorText>
              </Field.Root>
              <Center>
                <Button
                  colorPalette="blue"
                  mt={2}
                  loading={isSubmitting}
                  borderWidth={2}
                  borderColor={isValid ? "lightblue" : "red"}
                  type="submit"
                >OK</Button>
              </Center>
            </form>
          </Center>
          <Center color="red" fontSize="lg">
            {isWhiteListed === false && "Sorry, you are not in the list of valid voters."}
            {isWhiteListed === true && secretValid === false && "Sorry, your secret is not valid."}
          </Center>
        </>
      ) : (
        <Center fontSize="xl" pt={4}>
          Your email:
          <Text fontWeight={600}>
            {email}
          </Text>
        </Center>
      )}
    </>
  )
}
